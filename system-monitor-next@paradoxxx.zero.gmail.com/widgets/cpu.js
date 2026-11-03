/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import GTop from "gi://GTop";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { sm_log } from '../utils.js';
import { ElementBase, l_limit } from '../base.js';

// GNOME Shell never calls disable() on logout or shutdown, so destroy() alone
// cannot persist the average across a reboot.
const AVG_SAVE_INTERVAL_US = 60 * GLib.USEC_PER_SEC;

const Cpu = class SystemMonitor_Cpu extends ElementBase {
    static metadata = {
        name: 'CPU',
        metrics: [
            { key: 'user', color: true },
            { key: 'system', color: true },
            { key: 'nice', color: true },
            { key: 'iowait', color: true },
            { key: 'other', color: true },
        ],
        tooltipUnit: '%',
    };

    constructor(extension, config) {
        super(extension, config);

        this.avg_sum = 0;
        this.avg_count = 0;
        this.avg_history = [];
        this._lastAvgSave = GLib.get_monotonic_time();

        this.max = 100;

        if (this.device_id === 'all') {
            this.cpuid = -1;
        } else {
            this.cpuid = parseInt(this.device_id);
        }

        this.cursor = extension._Samplers.cpu.cursor();
        this._missingLogged = false;
        this.last = [0, 0, 0, 0, 0];
        this.current = [0, 0, 0, 0, 0];
        try {
            this.total_cores = GTop.glibtop_get_sysinfo().ncpu;
            if (this.cpuid === -1) {
                this.max *= this.total_cores;
            }
        } catch (e) {
            this.total_cores = 1;
            console.error(e);
        }
        this.last_total = 0;
        this.usage = [0, 0, 0, 1, 0];

        if (this.config['restore-average'])
            // Restore the running average across enable/disable cycles
            // Must run after this.max/this.total_cores are finalized above,
            this._loadAvgState();

        if (this.cpuid !== -1) {
            // Core ids are zero-based and core names are one-based, here and in
            // the preferences picker.
            this.device_name = String(this.cpuid + 1);
            this.item_name = _('CPU') + ' ' + (this.cpuid + 1);
            this.label.text = _('CPU') + (this.cpuid + 1);
        } else {
            this.item_name = _('CPU');
        }

    }

    // A config can name a core this machine does not have -- carried over from
    // a machine with more of them, or written by hand. Named the way the menu
    // and the preferences picker name it, one-based, so that whoever saw "--"
    // beside a number can look that number up. How many cores there are is what
    // separates a bad selection from a machine with a core offline.
    _reportMissing() {
        if (this._missingLogged)
            return;
        this._missingLogged = true;
        sm_log(`${this.item_name}: this machine has ${this.total_cores} cores. Showing --.`, 'warn');
    }

    collect() {
        const reading = this.cursor.sample();
        // The aggregate divides by the machine's total jiffies, a per-core
        // instance by that core's -- otherwise the same arithmetic.
        const counters = this.cpuid === -1 ? reading.data : reading.data.core(this.cpuid);
        // A core this machine does not have, or one offlined since this widget
        // was built: GTop's xcpu arrays are a fixed 1024 entries and zero-filled
        // wherever a core's counters were not read. Jiffies are cumulative since
        // boot, so any online core has thousands and a zero-filled slot has
        // none. Without this the delta is exactly 0 on every tick, neither arm
        // below fires, and the panel shows the value this.usage was initialised
        // with -- a permanent 99%. A core brought online this second reads as no
        // reading for one tick, which is honest.
        if (!(counters.total > 0)) {
            this._reportMissing();
            return null;
        }
        this._missingLogged = false;
        const scale = this.cpuid === -1 ? 100 * this.total_cores : 100;

        this.current[0] = counters.user;
        this.current[1] = counters.system;
        this.current[2] = counters.nice;
        this.current[3] = counters.idle;
        this.current[4] = counters.iowait;
        let delta = (counters.total - this.last_total) / scale;

        if (delta > 0) {
            for (let i = 0; i < 5; i++) {
                this.usage[i] = Math.round((this.current[i] - this.last[i]) / delta);
                this.last[i] = this.current[i];
            }
            this.last_total = counters.total;
        } else if (delta < 0) {
            this.last = [0, 0, 0, 0, 0];
            this.current = [0, 0, 0, 0, 0];
            this.last_total = 0;
            this.usage = [0, 0, 0, 1, 0];
        }

        let percent;
        if (this.cpuid === -1) {
            percent = Math.round(((100 * this.total_cores) - this.usage[3]) /
                                 this.total_cores);
        } else {
            percent = Math.round((100 - this.usage[3]));
        }

        // The graph width can shrink at runtime, so trim in a loop. Floor at 1
        // to keep the division below from seeing an empty window.
        const max_samples = Math.max(1, this.chart.width);
        this.avg_sum += percent;
        this.avg_history.push(percent);
        while (this.avg_history.length > max_samples)
            this.avg_sum -= this.avg_history.shift();
        this.avg_count = this.avg_history.length;
        let avg = Math.round(this.avg_sum / this.avg_count);

        if (this.config['restore-average']) {
            const now = GLib.get_monotonic_time();
            if (now - this._lastAvgSave >= AVG_SAVE_INTERVAL_US) {
                this._lastAvgSave = now;
                this._saveAvgStateAsync();
            }
        }

        let other = 100;
        for (let i = 0; i < this.usage.length; i++) {
            other -= this.usage[i];
        }
        other = Math.max(0, other);

        return {
            metrics: {
                user: this.usage[0],
                system: this.usage[1],
                nice: this.usage[2],
                iowait: this.usage[4],
                other: other,
            },
            display: percent.toString(),
            extra: {
                average: avg.toString(),
            },
        };
    }
    create_extra_text_items() {
        const Style = this.extension._Style;
        return {
            average: new St.Label({
                text: '',
                style_class: Style.get('sm-status-value'),
                y_align: Clutter.ActorAlign.CENTER
            }),
            unit: new St.Label({
                text: '%',
                style_class: Style.get('sm-perc-label'),
                y_align: Clutter.ActorAlign.CENTER
            })
        };
    }
    _getAvgStateFile() {
        // Keyed by device_id so per-core monitors (cpu0, cpu1, ..., all)
        // don't clobber each other's saved state.
        return GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            `system-monitor-next-cpu-avg-${this.device_id}.json`
        ]);
    }
    _loadAvgState() {
        const path = this._getAvgStateFile();
        Gio.File.new_for_path(path).load_contents_async(null, (file, result) => {
            if (this._destroyed)
                return;
            this._applyAvgState(file, result, path);
        });
    }
    _applyAvgState(file, result, path) {
        try {
            const [, contents] = file.load_contents_finish(result);
            const state = JSON.parse(new TextDecoder().decode(contents));

            // Once a full graph width of samples could have arrived since the
            // save, every saved sample would have scrolled off the graph.
            const window_ms = this.chart.width * l_limit(this.config['refresh-time']);
            const age_ms = GLib.get_real_time() / 1000 - state.saved_at;

            if (typeof state.avg_sum === 'number' &&
                typeof state.avg_count === 'number' &&
                typeof state.saved_at === 'number' &&
                state.avg_count > 0 &&
                age_ms >= 0 && age_ms <= window_ms) {

                const avg = state.avg_sum / state.avg_count;
                if (this.chart.width < state.avg_count) {
                    this.avg_count = this.chart.width;
                    this.avg_sum = Math.round(avg * this.avg_count);
                } else {
                    this.avg_count = state.avg_count;
                    this.avg_sum = state.avg_sum;
                }

                // Rebuild a synthetic history: avg_count copies of the
                // average, so future shift()/push() behaves exactly as
                // if we'd been collecting all along.

                const roundedAvg = Math.round(this.avg_sum / this.avg_count);
                this.avg_history = new Array(this.avg_count).fill(roundedAvg);

                let remainder = this.avg_sum - (roundedAvg * this.avg_count);
                const step = remainder > 0 ? 1 : -1;
                remainder = Math.abs(remainder);
                for (let i = 0; i < remainder; i++) {
                    this.avg_history[i] += step;
                }

                // avg_history is on the normalized 0-100 percent scale (see `percent`
                // in collect()), but the chart's raw data (this.vals fed via update())
                // is on a 0-this.max scale, which is 100 * total_cores for the 'all'
                // aggregate widget. Scale up to match, or the seeded line renders far
                // too low (e.g. 20 on a max-400 chart draws at 5% height).
                const chart_scale = this.max / 100;
                const scaled_history = (chart_scale !== 1)
                    ? this.avg_history.map(v => v * chart_scale)
                    : this.avg_history;
                this.chart.seed_flat(scaled_history);

                GLib.unlink(path);
            }
        } catch {
            // No saved state yet, or file unreadable/corrupt - start fresh.
        }
    }
    _avgStateJson() {
        return JSON.stringify({
            avg_sum: this.avg_sum,
            avg_count: this.avg_count,
            saved_at: GLib.get_real_time() / 1000,
        });
    }
    _saveAvgState() {
        try {
            GLib.file_set_contents(this._getAvgStateFile(), this._avgStateJson());
        } catch (e) {
            console.error(e, 'SystemMonitor: failed to save CPU average state');
        }
    }
    _saveAvgStateAsync() {
        const bytes = new GLib.Bytes(new TextEncoder().encode(this._avgStateJson()));
        Gio.File.new_for_path(this._getAvgStateFile()).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.error(e, 'SystemMonitor: failed to save CPU average state');
                }
            });
    }
    destroy() {
        if (this.config['restore-average'])
            this._saveAvgState();
        super.destroy();
    }
}

export { Cpu };
