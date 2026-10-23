# Troubleshooting

Solutions for the most common problems with **System Monitor**
(`system-monitor@rajendrayadav.github.io`). See the
[extension README](README.md) for installation and settings.

---

## The extension does not appear

```bash
gnome-extensions list | grep system-monitor
gnome-extensions info system-monitor@rajendrayadav.github.io
```

- Check the UUID directory name exactly matches `metadata.json`.
- Recompile the schema after copying:
  `glib-compile-schemas ~/.local/share/gnome-shell/extensions/system-monitor@rajendrayadav.github.io/schemas`.
- Log out and back in on Wayland.
- Check the journal for `Error loading extension`.

## Settings window is empty or fails to open

`prefs.js` needs libadwaita and GTK 4, which GNOME 45+ provides. Run
`gnome-extensions prefs system-monitor@rajendrayadav.github.io` from a terminal
to see the error.

## Temperature or fan shows `N/A`

1. Check what the kernel exposes:

   ```bash
   grep . /sys/class/hwmon/hwmon*/name
   grep . /sys/class/hwmon/hwmon*/temp*_input 2>/dev/null
   grep . /sys/class/hwmon/hwmon*/fan*_input  2>/dev/null
   ```

2. Install `lm-sensors` and run `sensors-detect` if `hwmon` is empty.
   (The extension itself does not use `lm-sensors`; the package is only a
   convenient way to load the right kernel drivers.)
3. NVIDIA proprietary drivers: use `nvidia-smi` manually; the extension
   cannot read GPU temperature without a `hwmon` node.
4. A metric with no sensor is hidden from the panel; `N/A` only appears if a
   sensor exists but its current value is unreadable.

## Disk I/O is always zero

- Confirm that `/proc/diskstats` is readable and that `/sys/block` contains a
  physical disk.
- Network filesystems, FUSE mounts and ZFS pools are not represented as block
  devices and are therefore not counted.
- In containers, block-device information may be hidden by the runtime.

## Panel numbers look wrong

- CPU load is relative to the previous sample. Changing the refresh interval
  can cause one misleading sample; subsequent samples stabilise.
- RAM usage follows `MemTotal − MemAvailable`, which includes reclaimable
  cache accounting done by the kernel, not just anonymous memory.
- Disk throughput counts all physical disks together, including writes made
  by other users and services.

## High CPU usage caused by the extension

Raise the refresh interval (2 s or 5 s is plenty for a panel readout) and
disable metrics you do not need. Temperature and fan reads are the most
expensive part on machines with many sensors.

## Reset everything

```bash
gsettings reset-recursively org.gnome.shell.extensions.system-monitor
gnome-extensions disable system-monitor@rajendrayadav.github.io
gnome-extensions enable  system-monitor@rajendrayadav.github.io
```

---

## Collecting logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Look for `[SystemMonitor]` messages or JavaScript exceptions right after
enabling the extension. On X11 you can also press `Alt+F2`, type `lg`, and
open the **Extensions** tab in Looking Glass.
