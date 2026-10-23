/**
 * System Monitor — GNOME Shell extension
 * UUID: system-monitor@rajendrayadav.github.io
 *
 * Shows CPU load, RAM usage, disk read/write throughput, CPU/GPU
 * temperature and fan speed in the top bar using small symbolic icons.
 *
 * Click the panel widget for the quick menu (show/hide metrics, compact
 * mode, refresh rate, preferences). All values come from /proc and /sys;
 * no subprocesses and no network access.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ─── Paths ────────────────────────────────────────────────────────────────────
const PROC_STAT = '/proc/stat';
const PROC_MEMINFO = '/proc/meminfo';
const PROC_DISKSTATS = '/proc/diskstats';
const SYS_BLOCK = '/sys/block';
const HWMON_PATH = '/sys/class/hwmon';
const THERMAL_PATH = '/sys/class/thermal';

// Count whole disks only, so stacked/virtual devices are not counted twice
// (dm-0 on top of nvme0n1, loop devices, …).
const VIRTUAL_BLOCK_RE = /^(loop|ram|zram|dm-|md|sr|fd|nbd|drbd|rbd)/;

// Sensors that must never be reported as CPU/GPU temperature.
const SENSOR_SKIP_RE = /(nvme|drivetemp|iwlwifi|wifi|pch_|battery|bat\d|ddr|vrm|psu|spd5|acpi_fan)/;
const GPU_RE = /(gpu|amdgpu|radeon|nouveau|nvidia|i915|\bxe\b|intel.*graphics|arc|panfrost|mali|v3d|lima|adreno)/;
const CPU_RE = /(cpu|core|package|k10temp|coretemp|zenpower|tctl|tdie|soc|acpitz|x86_pkg|thinkpad|tcpu|peci|ccp)/;

const FALLBACK_ICONS = {
  'cpu': 'CPU',
  'ram': 'RAM',
  'disk-read': 'R',
  'disk-write': 'W',
  'temp': 'T',
  'gpu': 'GPU',
  'fan': 'FAN',
};

const INTERVAL_CHOICES = [500, 1000, 2000, 5000, 10000];

// Panel metrics: keep icons at the standard panel size so they match the
// shell's own status icons, and pair them with comfortable label text.
const PANEL_ICON_SIZE = 16;
const PANEL_LABEL_SIZE = 12;
const FALLBACK_ICON_SIZE = 10;

const DECODER = new TextDecoder();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFile(path) {
  try {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok || bytes === null)
      return null;
    return DECODER.decode(bytes).trim();
  } catch (_e) {
    return null;
  }
}

function listDir(path) {
  const names = [];
  try {
    const dir = GLib.Dir.open(path, 0);
    let name;
    while ((name = dir.read_name()) !== null)
      names.push(name);
    dir.close();
  } catch (_e) {
    // Missing or unreadable directory.
  }
  return names;
}

function exists(path) {
  return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatPercent(value) {
  return `${Math.round(clamp(value, 0, 100))}%`;
}

function formatTemp(celsius) {
  return `${Math.round(celsius)}°`;
}

function formatFan(rpm) {
  if (rpm >= 10000)
    return `${Math.round(rpm / 1000)}k`;
  if (rpm >= 1000)
    return `${(rpm / 1000).toFixed(1)}k`;
  return `${Math.round(rpm)}`;
}

/** "1.2M/s" — compact value for the panel. */
function formatSpeedShort(bytesPerSecond) {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)}${units[unit]}/s`;
}

/** "1.2 MB/s" — readable value for the menu. */
function formatSpeed(bytesPerSecond) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatBytes(bytes) {
  const gib = bytes / (1024 * 1024 * 1024);
  return gib >= 1
    ? `${gib.toFixed(1)} GiB`
    : `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
}

function sameColor(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

// ─── CPU ──────────────────────────────────────────────────────────────────────

function readCpuTimes() {
  const content = readFile(PROC_STAT);
  if (!content)
    return null;

  const line = content.split('\n', 1)[0];
  if (!line || !line.startsWith('cpu'))
    return null;

  const parts = line.trim().split(/\s+/).slice(1)
    .map(n => Number.parseInt(n, 10) || 0);
  if (parts.length < 4)
    return null;

  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0,
    irq = 0, softirq = 0, steal = 0] = parts;

  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  };
}

function readCpuCoreCount() {
  const content = readFile(PROC_STAT);
  if (!content)
    return 0;
  return content.split('\n').filter(l => /^cpu\d+\s/.test(l)).length;
}

// ─── RAM ──────────────────────────────────────────────────────────────────────

function readMemory() {
  const content = readFile(PROC_MEMINFO);
  if (!content)
    return {used: 0, total: 0, percent: 0};

  const info = {};
  for (const line of content.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0)
      continue;
    const key = line.slice(0, idx);
    const value = Number.parseInt(line.slice(idx + 1).trim(), 10);
    if (!Number.isNaN(value))
      info[key] = value * 1024; // values are kibibytes
  }

  const total = info.MemTotal || 0;
  const available = info.MemAvailable ??
    ((info.MemFree || 0) + (info.Buffers || 0) + (info.Cached || 0));
  const used = Math.max(0, total - available);

  return {used, total, percent: total > 0 ? (used / total) * 100 : 0};
}

// ─── Disk I/O ─────────────────────────────────────────────────────────────────

let _blockDevices = null;
let _blockDevicesAt = 0;

function getBlockDevices() {
  const now = GLib.get_monotonic_time();

  // Re-scan periodically so hot-plugged drives are picked up.
  if (_blockDevices && now - _blockDevicesAt < 30_000_000)
    return _blockDevices;

  _blockDevices = listDir(SYS_BLOCK).filter(name => !VIRTUAL_BLOCK_RE.test(name));
  _blockDevicesAt = now;
  return _blockDevices;
}

function readDiskCounters() {
  const content = readFile(PROC_DISKSTATS);
  if (!content)
    return null;

  const devices = new Set(getBlockDevices());
  let read = 0;
  let write = 0;

  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || !devices.has(fields[2]))
      continue;

    // Fields 5 and 9 are sectors (always 512-byte units).
    read += (Number.parseInt(fields[5], 10) || 0) * 512;
    write += (Number.parseInt(fields[9], 10) || 0) * 512;
  }

  return {read, write};
}

// ─── Temperature / fan sensors ────────────────────────────────────────────────

function classifySensor(chip, label) {
  const text = `${chip} ${label}`.toLowerCase();
  if (SENSOR_SKIP_RE.test(text))
    return null;
  if (GPU_RE.test(text))
    return 'gpu';
  if (CPU_RE.test(text))
    return 'cpu';
  return null;
}

function readTempValue(path) {
  const raw = readFile(path);
  if (!raw)
    return null;

  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value))
    return null;

  // hwmon and thermal zones report millidegrees Celsius.
  const celsius = Math.abs(value) > 1000 ? value / 1000 : value;
  return celsius > 0 && celsius < 150 ? celsius : null;
}

function readFanValue(path) {
  const raw = readFile(path);
  if (!raw)
    return null;

  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) || value < 0 ? null : value;
}

class SensorSet {
  constructor() {
    this.cpuTemps = [];
    this.gpuTemps = [];
    this.fans = [];

    this._scanHwmon();
    this._scanThermal();
  }

  _scanHwmon() {
    for (const entry of listDir(HWMON_PATH)) {
      const base = `${HWMON_PATH}/${entry}`;
      const chip = (readFile(`${base}/name`) || '').toLowerCase();

      for (let i = 1; ; i++) {
        const input = `${base}/temp${i}_input`;
        if (!exists(input))
          break;

        const label = readFile(`${base}/temp${i}_label`) || '';
        const kind = classifySensor(chip, label);
        if (kind === 'cpu')
          this.cpuTemps.push({path: input, label: label || chip});
        else if (kind === 'gpu')
          this.gpuTemps.push({path: input, label: label || chip});
      }

      for (let i = 1; ; i++) {
        const input = `${base}/fan${i}_input`;
        if (!exists(input))
          break;

        const label = readFile(`${base}/fan${i}_label`) || chip;
        this.fans.push({path: input, label});
      }
    }
  }

  _scanThermal() {
    if (this.cpuTemps.length > 0 && this.gpuTemps.length > 0)
      return;

    for (const entry of listDir(THERMAL_PATH)) {
      if (!entry.startsWith('thermal_zone'))
        continue;

      const base = `${THERMAL_PATH}/${entry}`;
      const type = readFile(`${base}/type`) || '';
      const input = `${base}/temp`;
      if (!exists(input))
        continue;

      const kind = classifySensor(type, '');
      if (kind === 'cpu' && this.cpuTemps.length === 0)
        this.cpuTemps.push({path: input, label: type});
      else if (kind === 'gpu' && this.gpuTemps.length === 0)
        this.gpuTemps.push({path: input, label: type});
    }
  }

  get hasCpuTemp() {
    return this.cpuTemps.length > 0;
  }

  get hasGpuTemp() {
    return this.gpuTemps.length > 0;
  }

  get hasFan() {
    return this.fans.length > 0;
  }

  maxTemp(entries) {
    let max = null;
    for (const entry of entries) {
      const value = readTempValue(entry.path);
      if (value !== null && (max === null || value > max))
        max = value;
    }
    return max;
  }

  get cpuTemp() {
    return this.maxTemp(this.cpuTemps);
  }

  get gpuTemp() {
    return this.maxTemp(this.gpuTemps);
  }

  get fanSpeed() {
    let max = null;
    for (const entry of this.fans) {
      const value = readFanValue(entry.path);
      if (value !== null && (max === null || value > max))
        max = value;
    }
    return max;
  }
}

// ─── Metric definitions ───────────────────────────────────────────────────────

const METRICS = [
  {id: 'cpu', icon: 'cpu', placeholder: '--%', minWidth: 34, colorKey: 'cpu-color', settingKey: 'show-cpu', group: 'cpu'},
  {id: 'ram', icon: 'ram', placeholder: '--%', minWidth: 34, colorKey: 'ram-color', settingKey: 'show-ram', group: 'ram'},
  {id: 'diskRead', icon: 'disk-read', placeholder: '--/s', minWidth: 50, colorKey: 'disk-color', settingKey: 'show-disk', group: 'disk'},
  {id: 'diskWrite', icon: 'disk-write', placeholder: '--/s', minWidth: 50, colorKey: 'disk-color', settingKey: 'show-disk', group: 'disk'},
  {id: 'cpuTemp', icon: 'temp', placeholder: '--°', minWidth: 34, colorKey: 'temp-color', settingKey: 'show-temp', group: 'temp', availability: 'hasCpuTemp'},
  {id: 'gpuTemp', icon: 'gpu', placeholder: '--°', minWidth: 34, colorKey: 'gpu-color', settingKey: 'show-gpu-temp', group: 'gpu', availability: 'hasGpuTemp'},
  {id: 'fan', icon: 'fan', placeholder: '--', minWidth: 40, colorKey: 'fan-color', settingKey: 'show-fan', group: 'fan', availability: 'hasFan'},
];

// ─── Extension ────────────────────────────────────────────────────────────────

export default class SystemMonitorExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._sensors = new SensorSet();
    this._cpuCores = readCpuCoreCount();

    this._prevCpu = null;
    this._prevDisk = null;
    this._lastUpdate = GLib.get_monotonic_time();
    this._interval = null;
    this._timerId = null;
    this._syncingMenu = false;

    this._cpuUsage = 0;
    this._memory = {used: 0, total: 0, percent: 0};
    this._readSpeed = 0;
    this._writeSpeed = 0;
    this._cpuTemp = null;
    this._gpuTemp = null;
    this._fanSpeed = null;

    this._metrics = {};
    this._menuItems = {};

    this._buildPanelWidget();
    this._buildMenu();

    this._settingsChangedId = this._settings.connect('changed', () => {
      this._applySettings();
      this._syncMenu();
    });

    Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

    this._applySettings();
    this._update();
  }

  // ── Panel widget ──────────────────────────────────────────────────────────

  _buildPanelWidget() {
    this._button = new PanelMenu.Button(0.5, 'System Monitor');
    this._button.add_style_class_name('system-monitor-button');

    this._container = new St.BoxLayout({
      style_class: 'system-monitor-container',
      y_align: Clutter.ActorAlign.CENTER,
    });

    for (const [index, def] of METRICS.entries()) {
      if (index > 0)
        this._container.add_child(this._createSeparator());

      const metric = this._createMetric(def);
      this._metrics[def.id] = metric;
      this._container.add_child(metric.box);
    }

    this._button.add_child(this._container);
  }

  _createMetric(def) {
    const color = this._settings.get_string(def.colorKey);
    const box = new St.BoxLayout({
      style_class: `system-monitor-metric system-monitor-${def.id}`,
      y_align: Clutter.ActorAlign.CENTER,
      style: 'spacing: 3px;',
    });

    const icon = this._createIcon(def.icon, color);
    const label = new St.Label({
      text: def.placeholder,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'system-monitor-label',
      style: this._labelStyle(color, def.minWidth),
    });

    box.add_child(icon);
    box.add_child(label);

    const available = def.availability ? this._sensors[def.availability] : true;

    return {
      id: def.id,
      box,
      icon,
      label,
      separator: null,
      colorKey: def.colorKey,
      settingKey: def.settingKey,
      group: def.group,
      minWidth: def.minWidth,
      available,
      baseColor: color,
      lastColor: color,
    };
  }

  _createIcon(name, color) {
    const path = GLib.build_filenamev([this.path, 'icons', `${name}-symbolic.svg`]);
    if (exists(path)) {
      return new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        icon_size: PANEL_ICON_SIZE,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'system-monitor-icon',
        style: `color: ${color}; -st-icon-style: symbolic;`,
      });
    }

    return new St.Label({
      text: FALLBACK_ICONS[name] ?? '·',
      y_align: Clutter.ActorAlign.CENTER,
      style: `font-size: ${FALLBACK_ICON_SIZE}px; font-weight: 700; color: ${color};`,
    });
  }

  _createSeparator() {
    return new St.Widget({
      style_class: 'system-monitor-separator',
      style: `width: 1px; height: ${PANEL_ICON_SIZE}px; background-color: rgba(255,255,255,0.18); margin: 0 7px;`,
      y_align: Clutter.ActorAlign.CENTER,
    });
  }

  _labelStyle(color, minWidth) {
    return `font-size: ${PANEL_LABEL_SIZE}px; font-weight: 600; color: ${color}; min-width: ${minWidth}px;`;
  }

  _applyColor(metric, color) {
    if (sameColor(metric.lastColor, color))
      return;

    metric.lastColor = color;
    metric.icon.set_style(metric.icon instanceof St.Icon
      ? `color: ${color}; -st-icon-style: symbolic;`
      : `font-size: ${FALLBACK_ICON_SIZE}px; font-weight: 700; color: ${color};`);
    metric.label.set_style(this._labelStyle(color, metric.minWidth));
  }

  // ── Quick menu (click the panel widget) ───────────────────────────────────

  _buildMenu() {
    this._menu = this._button.menu;
    this._menu.actor.add_style_class_name('system-monitor-menu');

    this._infoRows = [
      this._addInfoRow(),
      this._addInfoRow(),
      this._addInfoRow(),
      this._addInfoRow(),
    ];
    this._fanInfoRow = this._infoRows[3];

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const switches = [
      {key: 'show-cpu', label: 'CPU usage'},
      {key: 'show-ram', label: 'RAM usage'},
      {key: 'show-disk', label: 'Disk read / write'},
      {key: 'show-temp', label: 'CPU temperature'},
      {key: 'show-gpu-temp', label: 'GPU temperature', available: this._sensors.hasGpuTemp},
      {key: 'show-fan', label: 'Fan speed', available: this._sensors.hasFan},
    ];

    for (const entry of switches) {
      const item = new PopupMenu.PopupSwitchMenuItem(
        entry.label,
        this._settings.get_boolean(entry.key),
      );
      item.visible = entry.available ?? true;
      item.connect('toggled', (_item, state) => {
        if (this._syncingMenu)
          return;
        this._settings.set_boolean(entry.key, state);
      });
      this._menu.addMenuItem(item);
      this._menuItems[entry.key] = item;
    }

    const compactItem = new PopupMenu.PopupSwitchMenuItem(
      'Compact mode (hide icons)',
      this._settings.get_boolean('compact-mode'),
    );
    compactItem.connect('toggled', (_item, state) => {
      if (this._syncingMenu)
        return;
      this._settings.set_boolean('compact-mode', state);
    });
    this._menu.addMenuItem(compactItem);
    this._menuItems['compact-mode'] = compactItem;

    this._intervalMenu = new PopupMenu.PopupSubMenuMenuItem('Update interval');
    this._intervalItems = new Map();
    for (const interval of INTERVAL_CHOICES) {
      const item = new PopupMenu.PopupMenuItem(this._intervalLabel(interval));
      item.connect('activate', () => this._settings.set_int('update-interval', interval));
      this._intervalMenu.menu.addMenuItem(item);
      this._intervalItems.set(interval, item);
    }
    this._menu.addMenuItem(this._intervalMenu);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
    prefsItem.connect('activate', () => this.openPreferences());
    this._menu.addMenuItem(prefsItem);

    this._menu.connect('open-state-changed', (_menu, isOpen) => {
      if (!isOpen)
        return;
      this._refreshInfo();
      this._syncMenu();
    });

    this._syncMenu();
    this._refreshInfo();
  }

  _addInfoRow() {
    const item = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
    item.add_style_class_name('system-monitor-info-row');
    item.label.set_style('font-size: 11px; color: rgba(255, 255, 255, 0.75);');
    this._menu.addMenuItem(item);
    return item;
  }

  _intervalLabel(ms) {
    const marker = this._settings.get_int('update-interval') === ms ? '✓' : ' ';
    return `${marker} ${this._formatInterval(ms)}`;
  }

  _formatInterval(ms) {
    return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
  }

  _syncMenu() {
    if (!this._menu)
      return;

    this._syncingMenu = true;
    try {
      for (const [key, item] of Object.entries(this._menuItems))
        item.setToggleState(this._settings.get_boolean(key));

      const interval = this._settings.get_int('update-interval');
      for (const [value, item] of this._intervalItems)
        item.label.text = this._intervalLabel(value);

      if (this._intervalMenu)
        this._intervalMenu.label.text = `Update interval (${this._formatInterval(interval)})`;
    } finally {
      this._syncingMenu = false;
    }
  }

  _refreshInfo() {
    if (!this._infoRows)
      return;

    const cpuParts = [`CPU ${formatPercent(this._cpuUsage)}`];
    if (this._cpuCores > 0)
      cpuParts.push(`${this._cpuCores} threads`);
    if (this._cpuTemp !== null)
      cpuParts.push(`${formatTemp(this._cpuTemp)}C`);
    if (this._gpuTemp !== null)
      cpuParts.push(`GPU ${formatTemp(this._gpuTemp)}C`);

    const memoryPercent = this._memory.total > 0
      ? `  ·  ${formatPercent(this._memory.percent)}`
      : '';
    const memoryText = this._memory.total > 0
      ? `RAM  ${formatBytes(this._memory.used)} / ${formatBytes(this._memory.total)}${memoryPercent}`
      : 'RAM  --';

    this._infoRows[0].label.text = cpuParts.join('   ·   ');
    this._infoRows[1].label.text = memoryText;
    this._infoRows[2].label.text =
      `Disk  ↓ ${formatSpeed(this._readSpeed)}   ↑ ${formatSpeed(this._writeSpeed)}`;

    if (this._fanSpeed !== null)
      this._fanInfoRow.label.text = `Fan  ${Math.round(this._fanSpeed)} RPM`;
    this._fanInfoRow.visible = this._fanSpeed !== null;
  }

  // ── Settings / visibility ─────────────────────────────────────────────────

  _applySettings() {
    const compact = this._settings.get_boolean('compact-mode');
    let previousGroup = null;

    for (const def of METRICS) {
      const metric = this._metrics[def.id];
      if (!metric)
        continue;

      const visible = this._settings.get_boolean(metric.settingKey) && metric.available;
      metric.box.visible = visible;
      metric.icon.visible = visible && !compact;

      metric.separator = metric.box.get_previous_sibling();
      if (metric.separator) {
        metric.separator.visible = visible && previousGroup !== null &&
          previousGroup !== metric.group;
      }

      if (visible)
        previousGroup = metric.group;
    }

    for (const metric of Object.values(this._metrics)) {
      const color = this._settings.get_string(metric.colorKey);
      metric.baseColor = color;
      this._applyColor(metric, color);
    }

    this._restartTimer();
  }

  _startTimer() {
    this._interval = this._settings.get_int('update-interval');
    this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._interval, () => {
      this._update();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _restartTimer() {
    const interval = this._settings.get_int('update-interval');
    if (this._timerId && interval === this._interval)
      return;

    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = null;
    }
    this._startTimer();
  }

  // ── Update loop ───────────────────────────────────────────────────────────

  _update() {
    const now = GLib.get_monotonic_time();
    const dt = (now - this._lastUpdate) / 1_000_000;
    this._lastUpdate = now;

    this._updateCpu();
    this._updateMemory();
    this._updateDisk(dt);
    this._updateTemperatures();
    this._updateFan();
  }

  _updateCpu() {
    const current = readCpuTimes();
    if (current && this._prevCpu) {
      const total = current.total - this._prevCpu.total;
      const idle = current.idle - this._prevCpu.idle;
      if (total > 0)
        this._cpuUsage = clamp((1 - idle / total) * 100, 0, 100);
    }
    this._prevCpu = current;

    this._metrics.cpu.label.set_text(formatPercent(this._cpuUsage));
  }

  _updateMemory() {
    this._memory = readMemory();
    this._metrics.ram.label.set_text(formatPercent(this._memory.percent));
  }

  _updateDisk(dt) {
    const current = readDiskCounters();
    if (current && this._prevDisk && dt > 0) {
      const read = (current.read - this._prevDisk.read) / dt;
      const write = (current.write - this._prevDisk.write) / dt;

      // A removed device resets its counters; never show negative speeds.
      this._readSpeed = Math.max(0, read);
      this._writeSpeed = Math.max(0, write);
    }
    this._prevDisk = current;

    this._metrics.diskRead.label.set_text(formatSpeedShort(this._readSpeed));
    this._metrics.diskWrite.label.set_text(formatSpeedShort(this._writeSpeed));
  }

  _updateTemperatures() {
    this._cpuTemp = this._sensors.cpuTemp;
    this._gpuTemp = this._sensors.gpuTemp;

    this._updateTempMetric(this._metrics.cpuTemp, this._cpuTemp);
    this._updateTempMetric(this._metrics.gpuTemp, this._gpuTemp);
  }

  _updateTempMetric(metric, value) {
    const color = value === null
      ? metric.baseColor
      : this._temperatureColor(value, metric.baseColor);
    metric.label.set_text(value === null ? 'N/A' : formatTemp(value));
    this._applyColor(metric, color);
  }

  _temperatureColor(value, baseColor) {
    if (value >= this._settings.get_int('critical-temp'))
      return '#f38ba8';
    if (value >= this._settings.get_int('warning-temp'))
      return '#fab387';
    return baseColor;
  }

  _updateFan() {
    this._fanSpeed = this._sensors.fanSpeed;
    this._metrics.fan.label.set_text(this._fanSpeed === null
      ? 'N/A'
      : formatFan(this._fanSpeed));
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  disable() {
    if (this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = null;
    }

    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = null;
    }

    if (this._button) {
      this._button.destroy(); // also destroys its menu
      this._button = null;
    }

    _blockDevices = null;
    _blockDevicesAt = 0;

    this._container = null;
    this._menu = null;
    this._metrics = {};
    this._menuItems = {};
    this._intervalItems = null;
    this._infoRows = null;
    this._fanInfoRow = null;
    this._sensors = null;
    this._prevCpu = null;
    this._prevDisk = null;
    this._settings = null;
  }
}
