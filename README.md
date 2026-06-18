# Notificate

A GNOME Shell extension that **stacks notification banners** instead of showing
them one at a time.

By default, GNOME Shell shows a single notification banner and queues the rest —
each new notification has to wait for the previous one to time out or be
dismissed before it appears. Notificate shows every banner immediately and piles
them up on screen, so nothing waits its turn (up to a limit you choose).

It also brings back a couple of niceties: choosing **where** on screen
notifications appear, and an optional **minimal banner layout**.

## Features

- **Stacked banners.** New notifications appear underneath the existing ones
  rather than queueing. Works for any number of notifications.
- **Configurable maximum.** Show up to *N* banners at once (default **5**). Extra
  notifications wait in a queue and appear as visible ones disappear. Set the
  maximum to **1** to reproduce stock GNOME behaviour.
- **On-screen position.** Independent horizontal (Fill / Left / Center / Right)
  and vertical (Fill / Top / Center / Bottom) alignment. The entrance animation
  follows the vertical position — banners slide down from the top, or scale in
  place elsewhere.
- **Minimal layout.** An optional *Hide App Title Row* mode that drops the app
  name, icon, and timestamp for a compact banner.
- **Plays nicely with the shell.** Honours Do Not Disturb, urgency levels,
  per-app notification settings, fullscreen/busy suppression, critical-urgency
  banners (which stay until dismissed and are exempt from the limit), and the
  notification list in the calendar/message tray.

## Installation

### From source

```sh
git clone git@github.com:gabe-grinspan/notificate.git
cd notificate
# Compile the settings schema
glib-compile-schemas schemas/
# Link it into the GNOME Shell extensions directory
ln -s "$PWD" "$HOME/.local/share/gnome-shell/extensions/notificate@gabe-grinspan.github.io"
```

Then restart GNOME Shell:

- **Wayland:** log out and back in.
- **X11:** press `Alt`+`F2`, type `r`, and press `Enter`.

Finally enable it:

```sh
gnome-extensions enable notificate@gabe-grinspan.github.io
```

## Settings

Open the preferences with:

```sh
gnome-extensions prefs notificate@gabe-grinspan.github.io
```

| Setting | Default | Description |
| --- | --- | --- |
| Maximum notifications | `5` | How many banners to stack at once (1–20). `1` ≈ stock GNOME. |
| Horizontal Alignment | `Center` | Horizontal position of notifications on screen. |
| Vertical Alignment | `Top` | Vertical position of notifications on screen. |
| Hide App Title Row | `Off` | Hide the title and time row for a minimal notification. |

## Compatibility

- GNOME Shell **50**

Notificate takes over banner display by intercepting how the shell's
`MessageTray` turns notifications into banners. If you run another extension that
also customises notification display (for example *Notification Configurator*),
you may see conflicts — disable one of them.

## Development

The extension is plain GJS (ES modules); there is no build step beyond compiling
the GSettings schema:

```sh
glib-compile-schemas schemas/
```

Useful while iterating:

```sh
# Watch the shell's log for errors from the extension
journalctl -f -o cat /usr/bin/gnome-shell
```

## License

This project is licensed under the GNU General Public License v3.0 or later
(`GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full text.
