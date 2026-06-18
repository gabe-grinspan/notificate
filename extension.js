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
import Pango from 'gi://Pango';
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

// A BinLayout whose reported size tracks the container's scale, so animating a
// wrapper's scale_y also shrinks/grows the space it claims in the parent box.
// That makes the surrounding banners reflow smoothly when one is added or
// removed instead of snapping into place. This is the same trick the shell's
// own message list uses (js/ui/messageList.js).
const ScaleLayout = GObject.registerClass(
class NotificateScaleLayout extends Clutter.BinLayout {
    _container = null;

    vfunc_set_container(container) {
        if (this._container === container)
            return;

        this._container?.disconnectObject(this);
        this._container = container;

        if (this._container) {
            this._container.connectObject(
                'notify::scale-x', () => this.layout_changed(),
                'notify::scale-y', () => this.layout_changed(), this);
        }
    }

    vfunc_get_preferred_width(container, forHeight) {
        const [min, nat] = super.vfunc_get_preferred_width(container, forHeight);
        return [
            Math.floor(min * container.scale_x),
            Math.floor(nat * container.scale_x),
        ];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [min, nat] = super.vfunc_get_preferred_height(container, forWidth);
        return [
            Math.floor(min * container.scale_y),
            Math.floor(nat * container.scale_y),
        ];
    }
});

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

        // The box expands to receive the full work area (so its alignment has
        // room to take effect, exactly like the shell's OSD and banner bin),
        // while staying its natural size and being positioned by x/y_align.
        // _applyAlignment() sets those aligns from the settings.
        this._box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
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
            top: Clutter.ActorAlign.START,
            center: Clutter.ActorAlign.CENTER,
            bottom: Clutter.ActorAlign.END,
        };

        const h = this._settings.get_string('horizontal-alignment');
        const v = this._settings.get_string('vertical-alignment');

        // The box always expands to fill the work area; the alignment then
        // positions the (natural-size) stack within it. A 'fill' choice maps to
        // ActorAlign.FILL, which stretches the banners along that axis.
        this._box.x_align = horizontal[h] ?? Clutter.ActorAlign.CENTER;
        this._box.y_align = vertical[v] ?? Clutter.ActorAlign.START;
    }

    // The vertical pivot for the grow/shrink animation, so banners expand from
    // (and collapse toward) the edge they are anchored to: down from the top,
    // up from the bottom, outward from the centre.
    _pivotY() {
        switch (this._settings.get_string('vertical-alignment')) {
        case 'bottom':
            return 1.0;
        case 'center':
            return 0.5;
        default:
            return 0.0;
        }
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

        switch (this._settings.get_string('notification-layout')) {
        case 'no-app-name':
            this._applyNoAppName(message);
            break;
        case 'compact':
            this._applyCompact(message, false);
            break;
        case 'compacter':
            this._applyCompact(message, true);
            break;
        }

        // Wrap the banner so its claimed height can be animated independently of
        // its contents, letting the rest of the stack reflow smoothly.
        const actor = new St.Bin({
            child: message,
            x_expand: true,
            layout_manager: new ScaleLayout(),
        });

        const item = {notification, message, actor, timeoutId: 0, removing: false};
        this._items.push(item);
        this._box.add_child(actor);

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

        this._animateIn(item);

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

        const actor = item.actor;
        actor.remove_all_transitions();

        const finish = () => {
            actor.destroy();
            this._processQueue();
        };

        if (animate)
            this._animateOut(item, finish);
        else
            finish();
    }

    // Grow the wrapper from a collapsed line into place. Because ScaleLayout
    // ties the claimed height to scale_y, the banners below slide down to make
    // room rather than jumping.
    _animateIn(item) {
        const actor = item.actor;
        actor.set_pivot_point(0.5, this._pivotY());
        actor.opacity = 0;
        actor.scale_y = 0;
        actor.ease({
            opacity: 255,
            scale_y: 1,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Collapse the wrapper back to a line; the rest of the stack slides up to
    // close the gap instead of snapping.
    _animateOut(item, onComplete) {
        const actor = item.actor;
        actor.set_pivot_point(0.5, this._pivotY());
        actor.ease({
            opacity: 0,
            scale_y: 0,
            duration: ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete,
        });
    }

    // "No app name" layout: drop the app-name/icon/time header row but keep the
    // title, body and the native close button (still its proper circular self).
    _applyNoAppName(message) {
        try {
            const header = message._header;
            const contentRow = message._icon?.get_parent();
            if (!header || !contentRow)
                return;

            // Remove the whole header row so it stops reserving a tall band at
            // the top (which made the banner top-heavy).
            header.hide();

            // Re-home the close button beside the title/body, vertically
            // centred, so the top and bottom padding stay symmetric. Wrapping
            // it in an element that carries the `message-header` style class
            // keeps the theme's `.message .message-header .message-close-button`
            // rule matching, so the button stays the normal circular "X"
            // instead of the bare, oversized glyph you get when it is reparented
            // out of any `.message-header` ancestor.
            const closeButton = header.closeButton;
            if (closeButton) {
                const wrapper = new St.Bin({
                    style_class: 'message-header notificate-close-wrapper',
                    y_align: Clutter.ActorAlign.CENTER,
                    y_expand: false,
                });
                header.remove_child(closeButton);
                closeButton.y_align = Clutter.ActorAlign.CENTER;
                wrapper.set_child(closeButton);
                contentRow.add_child(wrapper);
            }

            message.add_style_class_name('notificate-no-app-name');
        } catch (e) {
            logError(e, 'notificate: failed to apply no-app-name layout');
        }
    }

    // "Compact" / "Compacter" layout: replace the whole banner with a single
    // line of "App • Title: Body" (Compact), or just "Title: Body" when hideApp
    // is set (Compacter). We build our own line rather than reusing the native
    // header, because the header's TimeLabel re-shows itself whenever its
    // datetime is refreshed (so a hidden "Just now" keeps coming back). Only the
    // close button is borrowed, wrapped so it keeps its circular styling.
    _applyCompact(message, hideApp) {
        try {
            const notification = message.notification;
            const header = message._header;
            if (!notification || !header)
                return;

            const box = new St.BoxLayout({
                style_class: 'notificate-compact-box',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // The app name and separator dot are dropped in the "Compacter"
            // variant, leaving just the title and body.
            if (!hideApp) {
                const appLabel = new St.Label({
                    style_class: 'notificate-compact-app',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                notification.source.bind_property('title', appLabel, 'text',
                    GObject.BindingFlags.SYNC_CREATE);
                box.add_child(appLabel);

                const dot = new St.Label({
                    style_class: 'notificate-compact-dot',
                    text: '•',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                box.add_child(dot);
            }

            const titleLabel = new St.Label({
                style_class: 'notificate-compact-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            titleLabel.clutter_text.single_line_mode = true;
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            const updateText = () => {
                const title = (notification.title || '').replace(/\n/g, ' ');
                const body = (notification.body || '').replace(/\n/g, ' ');
                titleLabel.text = body ? `${title}: ${body}` : title;
            };
            updateText();
            notification.connectObject(
                'notify::title', updateText,
                'notify::body', updateText,
                message);
            box.add_child(titleLabel);

            // Borrow the native close button (circular "X"). Wrapping it in a
            // `message-header`-classed element keeps the theme styling matching
            // after it leaves the real header.
            const closeButton = header.closeButton;
            if (closeButton) {
                const wrapper = new St.Bin({
                    style_class: 'message-header notificate-close-wrapper',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                header.remove_child(closeButton);
                closeButton.y_align = Clutter.ActorAlign.CENTER;
                wrapper.set_child(closeButton);
                box.add_child(wrapper);
            }

            // Swap the full banner contents for the single-line box. The message
            // stays an St.Button, so click-to-activate still works.
            message.set_child(box);
            message.add_style_class_name('notificate-compact');
        } catch (e) {
            logError(e, 'notificate: failed to apply compact layout');
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
