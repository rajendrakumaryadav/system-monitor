/**
 * System Monitor — preferences
 * UUID: system-monitor@rajendrayadav.github.io
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEFAULT_COLORS = {
  'cpu-color': '#f38ba8',
  'ram-color': '#a6e3a1',
  'disk-color': '#f9e2af',
  'temp-color': '#89dceb',
  'gpu-color': '#94e2d5',
  'fan-color': '#89b4fa',
};

const COLOR_ROWS = [
  {key: 'cpu-color', title: 'CPU usage'},
  {key: 'ram-color', title: 'RAM usage'},
  {key: 'disk-color', title: 'Disk read / write'},
  {key: 'temp-color', title: 'CPU temperature'},
  {key: 'gpu-color', title: 'GPU temperature'},
  {key: 'fan-color', title: 'Fan speed'},
];

function rgbaToHex(rgba) {
  const channel = value => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}

export default class SystemMonitorPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    // `connectObject()` is a GNOME Shell-only GObject method and is not
    // available in the preferences process. Track the handlers ourselves so
    // they can be disconnected when the window is closed.
    this._settingHandlers = [];
    window.connect('destroy', () => {
      for (const handlerId of this._settingHandlers)
        settings.disconnect(handlerId);
      this._settingHandlers = [];
    });

    const page = new Adw.PreferencesPage({
      title: 'General',
      icon_name: 'preferences-system-symbolic',
    });
    window.add(page);

    this._addMetricsGroup(page, settings);
    this._addBehaviourGroup(page, settings);
    this._addColorsGroup(page, settings);
    this._addThresholdsGroup(page, settings);
  }

  _addMetricsGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Panel Metrics',
      description: 'Choose which values are shown in the top bar.',
    });
    page.add(group);

    group.add(this._switchRow(
      settings, 'show-cpu', 'CPU usage',
      'Overall processor load.'));
    group.add(this._switchRow(
      settings, 'show-ram', 'RAM usage',
      'Used physical memory.'));
    group.add(this._switchRow(
      settings, 'show-disk', 'Disk read / write',
      'Throughput of physical disks.'));
    group.add(this._switchRow(
      settings, 'show-temp', 'CPU temperature',
      'The hottest CPU sensor.'));
    group.add(this._switchRow(
      settings, 'show-gpu-temp', 'GPU temperature',
      'Shown only when a GPU temperature sensor is available.'));
    group.add(this._switchRow(
      settings, 'show-fan', 'Fan speed',
      'Shown only when a fan sensor is available.'));
  }

  _addBehaviourGroup(page, settings) {
    const group = new Adw.PreferencesGroup({title: 'Behaviour'});
    page.add(group);

    group.add(this._switchRow(
      settings, 'compact-mode', 'Compact mode',
      'Hide the icons and show only the values.'));

    const interval = new Adw.SpinRow({
      title: 'Update interval',
      subtitle: 'How often the values refresh, in milliseconds.',
      adjustment: new Gtk.Adjustment({
        lower: 500,
        upper: 10000,
        step_increment: 100,
        page_increment: 1000,
      }),
    });
    interval.value = settings.get_int('update-interval');
    interval.connect('notify::value', () => {
      const value = Math.round(interval.value);
      if (value !== settings.get_int('update-interval'))
        settings.set_int('update-interval', value);
    });
    this._watchSetting(settings, 'update-interval', () => {
      const value = settings.get_int('update-interval');
      if (Math.round(interval.value) !== value)
        interval.value = value;
    });
    group.add(interval);
  }

  _addColorsGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Colours',
      description: 'Colours used for the icons and values in the panel.',
    });
    page.add(group);

    const resetButton = new Gtk.Button({
      label: 'Reset',
      valign: Gtk.Align.CENTER,
    });
    resetButton.add_css_class('flat');
    resetButton.connect('clicked', () => {
      for (const [key, value] of Object.entries(DEFAULT_COLORS))
        settings.set_string(key, value);
      this._reloadColorButtons?.(settings);
    });
    group.set_header_suffix(resetButton);

    this._colorButtons = new Map();

    for (const {key, title} of COLOR_ROWS) {
      const row = new Adw.ActionRow({title});

      const rgba = new Gdk.RGBA();
      if (!rgba.parse(settings.get_string(key)))
        rgba.parse(DEFAULT_COLORS[key]);

      const button = new Gtk.ColorButton({
        rgba,
        use_alpha: false,
        valign: Gtk.Align.CENTER,
        title: `Select colour for ${title.toLowerCase()}`,
      });
      button.connect('color-set', () => {
        settings.set_string(key, rgbaToHex(button.rgba));
      });

      row.add_suffix(button);
      row.activatable_widget = button;

      this._colorButtons.set(key, {button, defaultColor: DEFAULT_COLORS[key]});
      group.add(row);
    }
  }

  _reloadColorButtons(settings) {
    for (const [key, {button, defaultColor}] of this._colorButtons ?? []) {
      const rgba = new Gdk.RGBA();
      if (!rgba.parse(settings.get_string(key)))
        rgba.parse(defaultColor);
      button.rgba = rgba;
    }
  }

  _addThresholdsGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: 'Temperature Alerts',
      description: 'The temperature value changes colour above these thresholds.',
    });
    page.add(group);

    group.add(this._intRow(
      settings, 'warning-temp',
      'Warning temperature',
      'Switch to the warning colour at this temperature (°C).',
      30, 110, 5));

    group.add(this._intRow(
      settings, 'critical-temp',
      'Critical temperature',
      'Switch to the critical colour at this temperature (°C).',
      40, 120, 5));
  }

  _switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _intRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
      title,
      subtitle,
      adjustment: new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 2,
      }),
    });

    row.value = settings.get_int(key);
    row.connect('notify::value', () => {
      const value = Math.round(row.value);
      if (value !== settings.get_int(key))
        settings.set_int(key, value);
    });
    this._watchSetting(settings, key, () => {
      const value = settings.get_int(key);
      if (Math.round(row.value) !== value)
        row.value = value;
    });

    return row;
  }

  _watchSetting(settings, key, callback) {
    this._settingHandlers.push(settings.connect(`changed::${key}`, callback));
  }
}
