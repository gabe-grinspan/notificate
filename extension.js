// SPDX-FileCopyrightText: 2026 Gabe Grinspan
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Notificate — stack notification banners instead of showing them one at a time.
//
// GNOME's MessageTray shows a single banner at a time and queues the rest,
// each one waiting for the previous to time out or be dismissed. This
// extension intercepts the point where the tray turns a notification into a
// banner and instead routes every banner through its own vertical stack, so
// notifications appear immediately and pile up underneath one another (up to a
// configurable maximum).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as MessageList from 'resource:///org/gnome/shell/ui/messageList.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as GnomeSession from 'resource:///org/gnome/shell/misc/gnomeSession.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const {Urgency, NotificationDestroyedReason, ANIMATION_TIME} = MessageTray;

// Matches the private NOTIFICATION_TIMEOUT constant in messageTray.js.
const NOTIFICATION_TIMEOUT = 4000;

// Manages the on-screen stack of notification banners. It owns its own chrome
// actor (a vertical box at the top-centre of the primary monitor) and takes
// over banner display from the shell's MessageTray.
class NotificationStack {
    constructor(settings) {
        this._settings = settings;

        // Currently visible banners, top to bottom. Each item is
        // {notification, message, timeoutId, removing}.
        this._items = [];
        // Notifications waiting for a free slot (or for the screen to stop
        // being busy/fullscreen), highest urgency first.
        this._queue = [];

        this._isBusy = false;
        this._origAddSource = null;

        this._buildActor();
        this._connectPresence();

        global.display.connectObject('in-fullscreen-changed',
            () => this._processQueue(), this);

        this._settings.connectObject(
            'changed::max-notifications', () => this._processQueue(),
            'changed::horizontal-alignment', () => this._applyAlignment(),
            'changed::vertical-alignment', () => this._applyAlignment(),
            this);

        this._applyAlignment();
        this._hookTray();
    }

    destroy() {
        // Stop new banner requests before tearing anything down.
        this._unhookTray();

        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);

        if (this._presence && this._presenceSignalId)
            this._presence.disconnectSignal(this._presenceSignalId);
        this._presence = null;
        this._presenceSignalId = 0;

        // Clear the queue first so tearing down a banner can't pull a waiting
        // notification back onto the (about to be destroyed) stack.
        this._queue = [];

        // Tear down every visible banner without animation.
        for (const item of this._items.slice())
            this._removeBanner(item, false);
        this._items = [];

        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
        this._box = null;
    }

    _buildActor() {
        // A non-reactive container that fills the primary monitor work area.
        // Because it is non-reactive, clicks pass through everywhere except on
        // the reactive banners themselves.
        this._actor = new St.Widget({
            name: 'notificate-stack',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });

        const constraint = new Layout.MonitorConstraint({primary: true});
        Main.layoutManager.panelBox.bind_property('visible',
            constraint, 'work-area',
            GObject.BindingFlags.SYNC_CREATE);
        this._actor.add_constraint(constraint);

        // Alignment (and the matching expand flags) are set by
        // _applyAlignment(); the box is sized to its content so x_align/y_align
        // actually position it within the work area.
        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
        });
        this._actor.add_child(this._box);

        Main.layoutManager.addChrome(this._actor);
    }

    // Map the alignment settings onto the stack's box, controlling where on
    // screen the banners sit. This mirrors the horizontal/vertical alignment
    // options from notification-configurator.
    _applyAlignment() {
        const horizontal = {
            fill: Clutter.ActorAlign.FILL,
            left: Clutter.ActorAlign.START,
            center: Clutter.ActorAlign.CENTER,
            right: Clutter.ActorAlign.END,
        };
        const vertical = {
            fill: Clutter.ActorAlign.FILL,
            top: Clutter.ActorAlign.START,
            center: Clutter.ActorAlign.CENTER,
            bottom: Clutter.ActorAlign.END,
        };

        const h = this._settings.get_string('horizontal-alignment');
        const v = this._settings.get_string('vertical-alignment');

        this._box.x_align = horizontal[h] ?? Clutter.ActorAlign.CENTER;
        this._box.y_align = vertical[v] ?? Clutter.ActorAlign.START;

        // Only fill the axis when explicitly asked to; otherwise the box keeps
        // its natural size so the alignment takes effect.
        this._box.x_expand = h === 'fill';
        this._box.y_expand = v === 'fill';
    }

    // Like notification-configurator, the entrance/exit animation is derived
    // from the vertical alignment: anchored to the top, banners slide down;
    // anywhere else they scale in place.
    _isTop() {
        const v = this._settings.get_string('vertical-alignment');
        return v === 'top' || v === 'fill';
    }

    _connectPresence() {
        this._presence = new GnomeSession.Presence((proxy, _error) => {
            if (proxy)
                this._onStatusChanged(proxy.status);
        });
        this._presenceSignalId = this._presence.connectSignal('StatusChanged',
            (proxy, senderName, [status]) => this._onStatusChanged(status));
    }

    _onStatusChanged(status) {
        if (status === GnomeSession.PresenceStatus.BUSY) {
            this._isBusy = true;
        } else if (status !== GnomeSession.PresenceStatus.IDLE) {
            // Preserve the previous value when going IDLE, matching the shell.
            this._isBusy = false;
        }

        if (!this._isBusy)
            this._processQueue();
    }

    // --- Tray interception -------------------------------------------------

    _hookTray() {
        const tray = Main.messageTray;
        this._tray = tray;
        const self = this;

        // Replace how new sources get wired up so that banner requests are
        // routed to us instead of the tray's single-banner machinery. New
        // sources (created when an app first posts a notification) go through
        // this automatically.
        this._origAddSource = tray._addSource;
        tray._addSource = function (source) {
            this._sources.add(source);
            self._connectSource(source);
            this.emit('source-added', source);
        };

        // Re-wire sources that already existed when we were enabled. We must
        // not re-emit 'source-added' for these (they are already in the
        // notification list), so we only swap the signal handlers.
        for (const source of tray.getSources()) {
            source.disconnectObject(tray);
            this._connectSource(source);
        }
    }

    _connectSource(source) {
        const tray = this._tray;
        source.connectObject(
            'notification-request-banner',
            (s, notification) => this._requestBanner(s, notification),
            'notification-removed',
            (s, notification) => this._notificationRemoved(s, notification),
            'destroy', () => tray._removeSource(source),
            this);
    }

    _unhookTray() {
        const tray = this._tray;
        if (!tray)
            return;

        // Restore the original _addSource (it lives on the prototype, so
        // deleting our instance override is enough).
        if (Object.prototype.hasOwnProperty.call(tray, '_addSource'))
            delete tray._addSource;

        // Hand every source back to the tray's own banner handling.
        for (const source of tray.getSources()) {
            source.disconnectObject(this);
            source.connectObject(
                'notification-request-banner',
                tray._onNotificationRequestBanner.bind(tray),
                'notification-removed',
                tray._onNotificationRemoved.bind(tray),
                'destroy', () => tray._removeSource(source),
                tray);
        }

        this._tray = null;
        this._origAddSource = null;
    }

    // --- Banner lifecycle --------------------------------------------------

    // Mirrors MessageTray._onNotificationRequestBanner's filtering, then either
    // shows the banner or queues it.
    _requestBanner(source, notification) {
        if (notification.acknowledged)
            return;

        if (notification.urgency === Urgency.LOW)
            return;

        if (!source.policy.showBanners && notification.urgency !== Urgency.CRITICAL)
            return;

        const existing = this._items.find(i => i.notification === notification);
        if (existing) {
            // An already-visible notification was updated: its content is
            // bound, so just refresh the auto-hide timer.
            this._resetTimeout(existing);
            return;
        }

        if (this._queue.includes(notification))
            return;

        if (!this._tryShow(notification)) {
            this._queue.push(notification);
            this._queue.sort((a, b) => b.urgency - a.urgency);
        }
    }

    _notificationRemoved(_source, notification) {
        const item = this._items.find(i => i.notification === notification);
        if (item) {
            this._removeBanner(item, true);
            return;
        }
        const index = this._queue.indexOf(notification);
        if (index !== -1)
            this._queue.splice(index, 1);
    }

    // Returns true if the notification was shown, false if it should wait.
    _tryShow(notification) {
        const isCritical = notification.urgency === Urgency.CRITICAL;

        const limited = this._isBusy ||
            (Main.layoutManager.primaryMonitor?.inFullscreen ?? false);
        if (limited && !notification.forFeedback && !isCritical)
            return false;

        const max = this._settings.get_int('max-notifications');
        if (this._items.length >= max && !isCritical)
            return false;

        this._addBanner(notification);
        return true;
    }

    _processQueue() {
        while (this._queue.length > 0) {
            if (this._tryShow(this._queue[0]))
                this._queue.shift();
            else
                break;
        }
    }

    _addBanner(notification) {
        notification.acknowledged = true;
        notification.playSound();

        const message = new MessageList.NotificationMessage(notification);
        message.can_focus = false;
        message.add_style_class_name('notification-banner');

        if (this._settings.get_boolean('hide-app-title-row'))
            this._applyMinimal(message);

        const item = {notification, message, timeoutId: 0, removing: false};
        this._items.push(item);
        this._box.add_child(message);

        message.connectObject(
            'close', () => this._removeBanner(item, true),
            'notify::hover', () => this._onHover(item),
            'expanded', () => this._clearTimeout(item),
            'unexpanded', () => this._resetTimeout(item),
            this);

        // Auto-expand critical notifications and those whose source asks for it.
        if (notification.urgency === Urgency.CRITICAL ||
            notification.source.policy.forceExpanded)
            message.expand(false);

        this._animateIn(message);

        if (notification.urgency !== Urgency.CRITICAL)
            this._resetTimeout(item);
    }

    _onHover(item) {
        if (item.message.hover) {
            // Keep the banner up while the pointer is over it.
            this._clearTimeout(item);
        } else if (!item.message.expanded &&
                   item.notification.urgency !== Urgency.CRITICAL) {
            this._resetTimeout(item);
        }
    }

    _resetTimeout(item) {
        this._clearTimeout(item);
        if (item.notification.urgency === Urgency.CRITICAL)
            return;
        item.timeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            NOTIFICATION_TIMEOUT, () => {
                item.timeoutId = 0;
                this._onTimeout(item);
            });
        GLib.Source.set_name_by_id(item.timeoutId, '[notificate] banner timeout');
    }

    _clearTimeout(item) {
        if (item.timeoutId) {
            GLib.source_remove(item.timeoutId);
            item.timeoutId = 0;
        }
    }

    _onTimeout(item) {
        const notification = item.notification;
        // Transient notifications are expired (and thus destroyed) when their
        // banner times out, just like the stock tray does. Everything else
        // simply loses its banner but stays in the notification list.
        if (notification.isTransient)
            notification.destroy(NotificationDestroyedReason.EXPIRED);
        else
            this._removeBanner(item, true);
    }

    _removeBanner(item, animate) {
        if (item.removing)
            return;
        item.removing = true;

        this._clearTimeout(item);
        item.message.disconnectObject(this);

        const index = this._items.indexOf(item);
        if (index !== -1)
            this._items.splice(index, 1);

        const message = item.message;
        message.remove_all_transitions();

        const finish = () => {
            message.destroy();
            this._processQueue();
        };

        if (animate)
            this._animateOut(message, finish);
        else
            finish();
    }

    _animateIn(message) {
        message.opacity = 0;
        message.set_pivot_point(0.5, 0.5);

        if (this._isTop()) {
            // Slide down from above, like the stock top banner.
            const height = message.get_preferred_height(-1)[1] || 64;
            message.translation_y = -height;
            message.ease({
                opacity: 255,
                translation_y: 0,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            message.scale_x = 0.9;
            message.scale_y = 0.9;
            message.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _animateOut(message, onComplete) {
        message.set_pivot_point(0.5, 0.5);

        if (this._isTop()) {
            const height = message.height || message.get_preferred_height(-1)[1] || 64;
            message.ease({
                opacity: 0,
                translation_y: -height,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete,
            });
        } else {
            message.ease({
                opacity: 0,
                scale_x: 0.9,
                scale_y: 0.9,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete,
            });
        }
    }

    // Minimal layout: drop the app-name/icon/time header but keep the close
    // button, moving it beside the title/body. Mirrors the "Hide App Title
    // Row" option from notification-configurator.
    _applyMinimal(message) {
        try {
            const header = message._header;
            if (!header)
                return;

            // Remove everything from the header except the expand/close
            // buttons (i.e. the app icon and the source-name/time block).
            for (const child of header.get_children()) {
                if (child !== header.expandButton && child !== header.closeButton)
                    child.destroy();
            }
            header.x_expand = false;

            // Move the now button-only header into the content row so the
            // close button sits next to the title/body instead of above it.
            const contentRow = message._icon?.get_parent();
            if (contentRow) {
                header.get_parent()?.remove_child(header);
                contentRow.add_child(header);
            }

            message.add_style_class_name('notificate-minimal');
        } catch (e) {
            logError(e, 'notificate: failed to apply minimal layout');
        }
    }
}

export default class NotificateExtension extends Extension {
    enable() {
        this._stack = new NotificationStack(this.getSettings());
    }

    disable() {
        this._stack?.destroy();
        this._stack = null;
    }
}
