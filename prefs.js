// SPDX-FileCopyrightText: 2026 Gabe Grinspan
// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HORIZONTAL_VALUES = ['fill', 'left', 'center', 'right'];
const VERTICAL_VALUES = ['top', 'center', 'bottom'];
const LAYOUT_VALUES = ['default', 'no-app-name', 'compact', 'compacter'];

export default class NotificatePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-notifications-symbolic',
        });
        window.add(page);

        // --- Stack -------------------------------------------------------
        const stackGroup = new Adw.PreferencesGroup({
            title: _('Banner Stack'),
            description: _('Control how many notification banners are shown on screen at once.'),
        });
        page.add(stackGroup);

        const maxRow = new Adw.SpinRow({
            title: _('Maximum notifications'),
            subtitle: _('How many banners to stack at the same time. Extra notifications wait their turn. Set to 1 for the default GNOME behaviour.'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 20,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        stackGroup.add(maxRow);
        // Gio.SettingsBindFlags.DEFAULT === 0
        settings.bind('max-notifications', maxRow, 'value', 0);

        // --- Position ----------------------------------------------------
        const positionGroup = new Adw.PreferencesGroup({
            title: _('Position'),
            description: _('Where notifications appear on screen.'),
        });
        page.add(positionGroup);

        positionGroup.add(this._buildComboRow(settings, {
            key: 'horizontal-alignment',
            values: HORIZONTAL_VALUES,
            title: _('Horizontal Alignment'),
            subtitle: _('Horizontal position of notifications on screen'),
            labels: [_('Fill'), _('Left'), _('Center'), _('Right')],
        }));

        positionGroup.add(this._buildComboRow(settings, {
            key: 'vertical-alignment',
            values: VERTICAL_VALUES,
            title: _('Vertical Alignment'),
            subtitle: _('Vertical position of notifications on screen'),
            labels: [_('Top'), _('Center'), _('Bottom')],
        }));

        // --- Appearance --------------------------------------------------
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Customize how notifications look.'),
        });
        page.add(appearanceGroup);

        appearanceGroup.add(this._buildComboRow(settings, {
            key: 'notification-layout',
            values: LAYOUT_VALUES,
            title: _('Notification Layout'),
            subtitle: _('How much of each banner to show'),
            labels: [_('Default'), _('No app row'), _('Compact'), _('Compacter')],
        }));

        const expandRow = new Adw.SwitchRow({
            title: _('Show expand arrow'),
            subtitle: _('Let banners be expanded to reveal the full body. In the compact layouts the body is hidden until expanded.'),
        });
        appearanceGroup.add(expandRow);
        // Gio.SettingsBindFlags.DEFAULT === 0
        settings.bind('show-expand-arrow', expandRow, 'active', 0);

        window.set_default_size(560, 420);
    }

    _buildComboRow(settings, {key, values, title, subtitle, labels}) {
        const row = new Adw.ComboRow({title, subtitle});

        const model = new Gtk.StringList();
        for (const label of labels)
            model.append(label);
        row.set_model(model);

        const sync = () => {
            const index = values.indexOf(settings.get_string(key));
            row.set_selected(index >= 0 ? index : 0);
        };
        sync();

        row.connect('notify::selected', () => {
            const value = values[row.get_selected()];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        // Reflect external changes (e.g. reset) back into the combo.
        settings.connect(`changed::${key}`, sync);

        return row;
    }
}
