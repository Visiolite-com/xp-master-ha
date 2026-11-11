// Netroni circadian profiles: the list and the curve editor of the panel's Circadian tab (xp-master
// docs/circadian.md). A plain web component the panel mounts per XP-Master and keeps across its own
// redraws, so what is being edited survives them. The panel sets `hass`, `entry`, `master` (lights,
// groups, scenes), `status` (netroni/circadian_status) and `admin`; a saved change comes back as the
// new status, given to `onStatus`.
//
// The curves are drawn with the XP-Master's own formulas (circadian.py): smoothstep between points,
// round the clock; Seasons stretches the drawn day (sunrise 06:00, sunset 18:00) to the real one.

const DAY = 1440;
const DRAWN = [360, 1080]; // Seasons: the day a profile is drawn for
const KELVIN = [1000, 6500]; // a profile's colour temperatures (limits.kelvin)
const STEP_MIN = 5;
const STEP_SEASON = 15; // minutes: a tap on the day's start or end (as the apps)
const STEP_K = 50;
const STEP_PCT = 5;
const COLOURS = { colour: "#c27c00", dimming: "var(--primary-color, #0874b6)" };
const SHAPE_NAMES = { home: "Home: slow morning, warm evening", office: "Office: cool by mid-morning", natural: "Natural: the colour of sunlight" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wrap = (t) => ((t % DAY) + DAY) % DAY;
const clock = (t) => {
  const m = wrap(Math.round(t));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const minutes = (text) => {
  if (!text) return null;
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
};
const smooth = (x) => {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
};

/** A curve's value at a minute: as circadian.value_at. */
function valueAt(points, t, steps) {
  const n = points.length;
  let i = -1;
  points.forEach((p, k) => { if (p[0] <= t) i = k; });
  const a = points[(i + n) % n];
  const b = points[(i + 1) % n];
  if (steps || n === 1) return a[1];
  const span = wrap(b[0] - a[0]) || DAY;
  return a[1] + (b[1] - a[1]) * smooth(wrap(t - a[0]) / span);
}

/** `t` on one day (start, end) to the same place on the other: as circadian._stretch. */
function stretch(t, from, to) {
  const d0 = from[1] - from[0];
  const d1 = to[1] - to[0];
  const x = wrap(t - from[0]);
  return wrap(x <= d0 ? to[0] + (x * d1) / d0 : to[1] + ((x - d0) * (DAY - d1)) / (DAY - d0));
}

class NetroniCircadian extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._edit = null; // {profile (a copy), dirty}
    this._active = "colour";
    this._sel = -1;
    this._day = "today"; // the day shown: "today" or a month 0 ... 11
    this._drag = false;
    this._busy = false;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("input", (ev) => {
      if (ev.target.id === "name" && this._edit) {
        this._edit.profile.name = ev.target.value;
        this._dirty();
      }
    });
    this.shadowRoot.addEventListener("pointerdown", (ev) => this._onDown(ev));
    this.shadowRoot.addEventListener("pointermove", (ev) => this._onMove(ev));
    this.shadowRoot.addEventListener("pointerup", () => this._endDrag());
    this.shadowRoot.addEventListener("pointercancel", () => this._endDrag());
    this.shadowRoot.addEventListener("keydown", (ev) => this._onKey(ev));
    // A point keeps the focus when the plot is drawn again (for the arrow keys), until something else takes it.
    this.shadowRoot.addEventListener("focusin", (ev) => { this._pointFocus = Boolean(ev.target.closest?.(".point")); });
  }

  set status(status) {
    this._status = status;
    const profiles = status?.profiles || [];
    if (this._edit && !this._edit.dirty && this._edit.profile.id) {
      const fresh = profiles.find((p) => p.id === this._edit.profile.id);
      this._edit = fresh ? { profile: this._copy(fresh), dirty: false } : null;
    }
    if (!this._edit && profiles.length) this._open(profiles[0]);
    if (!this._drag) this._render();
  }

  get status() {
    return this._status;
  }

  get dragging() {
    return this._drag;
  }

  connectedCallback() {
    this._render();
  }

  // --- the profile being edited ----------------------------------------------------------------

  _copy(profile) {
    const { kelvin, brightness, following, ...rest } = profile;
    return JSON.parse(JSON.stringify(rest));
  }

  _open(profile) {
    this._edit = { profile: this._copy(profile), dirty: false };
    this._active = profile.colour ? "colour" : "dimming";
    this._sel = -1;
  }

  _dirty() {
    if (this._edit) this._edit.dirty = true;
  }

  get _points() {
    return this._edit?.profile[this._active] || [];
  }

  _setPoints(points) {
    this._edit.profile[this._active] = points;
    this._dirty();
  }

  /** The day shown: sunrise and sunset (minutes, or null), and whether it is today. */
  _shownDay() {
    const st = this._status || {};
    if (this._day === "today") return { sunrise: minutes(st.sunrise), sunset: minutes(st.sunset), today: true };
    const day = st.days?.[this._day];
    return { sunrise: minutes(day?.sunrise), sunset: minutes(day?.sunset), today: false };
  }

  /** Seasons: the shown day's start and end, and the drawn day's (null: played on the clock). */
  _windows() {
    const p = this._edit?.profile;
    if (!p || p.mode !== "seasons") return null;
    const { sunrise, sunset } = this._shownDay();
    if (sunrise === null || sunset === null) return null;
    const real = [sunrise - p.before, sunset + p.after];
    const drawn = [DRAWN[0] - p.before, DRAWN[1] + p.after];
    if (!(real[1] - real[0] > 0 && real[1] - real[0] < DAY && drawn[1] - drawn[0] > 0 && drawn[1] - drawn[0] < DAY)) return null;
    return { real, drawn };
  }

  _shown(t) {
    const w = this._windows();
    return w ? stretch(t, w.drawn, w.real) : t;
  }

  _drawnMinute(t) {
    const w = this._windows();
    return w ? stretch(t, w.real, w.drawn) : t;
  }

  _norm(curve, v) {
    return curve === "colour" ? (v - KELVIN[0]) / (KELVIN[1] - KELVIN[0]) : v / 100;
  }

  _y(curve, v) {
    return 20 + 260 * (1 - Math.min(1, Math.max(0, this._norm(curve, v))));
  }

  _label(curve, v) {
    return curve === "colour" ? `${Math.round(v)} K` : `${Math.round(v)} %`;
  }

  _path(curve, drawn) {
    const p = this._edit.profile;
    const points = p[curve];
    if (!points?.length) return "";
    let d = "";
    for (let t = 0; t <= DAY; t += 3) {
      const at = drawn ? t % DAY : this._drawnMinute(t % DAY);
      d += `${t ? "L" : "M"}${t} ${this._y(curve, valueAt(points, at, p.mode === "steps")).toFixed(1)}`;
    }
    return d;
  }

  _move(i, t, v) {
    const points = this._points.map((p) => [...p]);
    const gap = this._status?.limits?.gap ?? 6;
    const lo = i > 0 ? points[i - 1][0] + gap : 0;
    const hi = i < points.length - 1 ? points[i + 1][0] - gap : DAY - 1;
    const range = this._active === "colour" ? KELVIN : [1, 100];
    points[i] = [Math.min(hi, Math.max(lo, Math.round(t))), Math.min(range[1], Math.max(range[0], Math.round(v)))];
    this._setPoints(points);
  }

  _nudge(dt, dv) {
    if (this._sel < 0) return;
    const [t, v] = this._points[this._sel];
    // Steps of the time shown (Seasons: on the day shown, not the drawn one).
    const to = dt ? this._drawnMinute(wrap(Math.round(this._shown(t)) + dt)) : t;
    this._move(this._sel, dt && Math.round(to) === t ? t + Math.sign(dt) : to, v + dv * (this._active === "colour" ? STEP_K : STEP_PCT));
    this._renderPlot();
  }

  _add() {
    const points = this._points.map((p) => [...p]);
    const max = this._status?.limits?.points ?? 25;
    const gap = this._status?.limits?.gap ?? 6;
    if (points.length >= max) return;
    let t;
    if (this._sel >= 0) {
      const a = points[this._sel][0];
      const b = this._sel < points.length - 1 ? points[this._sel + 1][0] : DAY;
      if (b - a < 2 * gap) return;
      t = Math.round((a + b) / 2);
    } else {
      t = Math.round(this._drawnMinute(720));
      while (points.some((p) => Math.abs(p[0] - t) < gap)) t = (t + gap) % DAY;
    }
    const v = points.length ? valueAt(points, t, this._edit.profile.mode === "steps") : (this._active === "colour" ? 3000 : 50);
    const point = [t, this._active === "colour" ? Math.round(v / STEP_K) * STEP_K : Math.round(v)];
    points.push(point);
    points.sort((a, b) => a[0] - b[0]);
    this._setPoints(points);
    this._sel = points.indexOf(point);
    this._render();
  }

  _delete() {
    const points = this._points.map((p) => [...p]);
    if (this._sel < 0 || points.length <= 1) return;
    points.splice(this._sel, 1);
    this._setPoints(points);
    this._sel = -1;
    this._render();
  }

  // --- talking to the XP-Master ----------------------------------------------------------------

  async _ws(msg) {
    try {
      return await this.hass.callWS({ entry_id: this.entry, ...msg });
    } catch (err) {
      this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message: err.message || String(err) }, bubbles: true, composed: true }));
      throw err;
    }
  }

  async _save() {
    const profile = this._edit.profile;
    if (!profile.name.trim()) {
      this._toast("Give the profile a name");
      return;
    }
    this._busy = true;
    this._render();
    try {
      // What follows another profile moves to this one (one profile each): off that one first (as the apps).
      for (const other of (this._status.profiles || []).filter((x) => x.id !== profile.id)) {
        const kinds = ["lights", "groups", "scenes"].filter((kind) => (other[kind] || []).some((id) => (profile[kind] || []).includes(id)));
        if (!kinds.length) continue;
        const left = this._copy(other);
        for (const kind of kinds) left[kind] = left[kind].filter((id) => !profile[kind].includes(id));
        this._status = await this._ws({ type: "netroni/circadian_profile_set", profile: left });
      }
      const status = await this._ws({ type: "netroni/circadian_profile_set", profile });
      this._edit = { profile: this._copy(status.profiles.find((p) => p.id === status.profile_id)), dirty: false };
      this.onStatus?.(status);
      this._toast(`${profile.name} saved`);
    } catch {
      // told in a toast
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _remove() {
    const profile = this._edit.profile;
    if (profile.id && !confirm(`Delete the profile ${profile.name}? Its lights, groups and scenes stop following it.`)) return;
    if (!profile.id) {
      this._edit = null;
      this.status = this._status;
      return;
    }
    try {
      const status = await this._ws({ type: "netroni/circadian_profile_delete", profile_id: profile.id });
      this._edit = null;
      this.onStatus?.(status);
    } catch {
      // told in a toast
    }
  }

  async _new() {
    const used = new Set((this._status?.profiles || []).map((p) => p.name));
    let n = 1;
    while (used.has(`Profile ${n}`)) n += 1;
    let colour = [[330, 2200], [450, 3200], [720, 4000], [1020, 3200], [1080, 2800], [1200, 2200]];
    try {
      colour = (await this._ws({ type: "netroni/circadian_shape", shape: "home", mode: "seasons" })).points;
    } catch {
      // the shape above
    }
    // Home's day: from its first point to its last (30 min before sunrise, 120 after sunset)
    this._edit = { profile: { name: `Profile ${n}`, mode: "seasons", before: 30, after: 120, colour, dimming: null,
      groups: [], lights: [], scenes: [] }, dirty: true };
    this._active = "colour";
    this._sel = -1;
    this._render();
  }

  async _shape(kind) {
    try {
      const p = this._edit.profile;
      const { points } = await this._ws({ type: "netroni/circadian_shape", shape: kind, mode: p.mode });
      if (p.mode === "seasons") {
        // The shape sets the profile's day: from its first point to its last (the dimming moves with it, as the apps).
        const limits = this._status?.limits || {};
        this._setWindow(Math.min(limits.before ?? 180, Math.max(0, DRAWN[0] - points[0][0])),
          Math.min(limits.after ?? 240, Math.max(0, points[points.length - 1][0] - DRAWN[1])));
      }
      p.colour = points;
      this._active = "colour";
      this._sel = -1;
      this._dirty();
    } catch {
      // told in a toast
    }
    this._render();
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  // --- events ----------------------------------------------------------------------------------

  _onClick(ev) {
    const el = ev.target.closest?.("[data-action]");
    if (!el || el.disabled) return;
    const d = el.dataset;
    const p = this._edit?.profile;
    switch (d.action) {
      case "open": {
        if (this._edit?.dirty && !confirm("Leave this profile without saving it?")) return;
        const profile = this._status.profiles.find((x) => x.id === d.id);
        if (profile) this._open(profile);
        break;
      }
      case "new":
        if (this._edit?.dirty && !confirm("Leave this profile without saving it?")) return;
        this._new();
        return;
      case "curve":
        this._active = d.curve;
        this._sel = -1;
        break;
      case "add-curve":
        p[d.curve] = d.curve === "colour" ? [[360, 2200], [720, 4000], [1080, 2700]] : [[360, 20], [480, 80], [1080, 100], [1260, 40]];
        this._active = d.curve;
        this._sel = -1;
        this._dirty();
        break;
      case "remove-curve": {
        const other = this._active === "colour" ? "dimming" : "colour";
        if (!p[other]) return;
        p[this._active] = null;
        this._active = other;
        this._sel = -1;
        this._dirty();
        break;
      }
      case "mode":
        p.mode = d.mode;
        this._dirty();
        break;
      case "add-point":
        this._add();
        return;
      case "delete-point":
        this._delete();
        return;
      case "nudge":
        this._nudge(Number(d.dt), Number(d.dv));
        return;
      case "window": {
        const limit = this._status.limits?.[d.key] ?? (d.key === "before" ? 180 : 240);
        const value = Math.min(limit, Math.max(0, p[d.key] + Number(d.d)));
        this._setWindow(d.key === "before" ? value : p.before, d.key === "after" ? value : p.after);
        this._dirty();
        break;
      }
      case "day":
        this._day = d.day === "today" ? "today" : Number(d.day);
        break;
      case "unassign":
        p[d.kind] = p[d.kind].filter((id) => id !== d.id);
        this._dirty();
        break;
      case "save":
        this._save();
        return;
      case "revert": {
        const saved = this._status.profiles.find((x) => x.id === p.id);
        if (saved) this._open(saved);
        else this._edit = null;
        if (!this._edit) this.status = this._status;
        break;
      }
      case "delete":
        this._remove();
        return;
      case "plot":
        if (ev.target.closest(".point")) return;
        this._sel = -1;
        break;
      default:
        return;
    }
    this._render();
  }

  /** Seasons: the day from before sunrise to after sunset. The points move with it: each keeps its share
   * of the day and of the night (as the apps); if that leaves two too close, they stay where they were. */
  _setWindow(before, after) {
    const p = this._edit.profile;
    const from = [DRAWN[0] - p.before, DRAWN[1] + p.after];
    p.before = before;
    p.after = after;
    const to = [DRAWN[0] - before, DRAWN[1] + after];
    if (from[0] === to[0] && from[1] === to[1]) return;
    const gap = this._status?.limits?.gap ?? 6;
    for (const curve of ["colour", "dimming"]) {
      if (!p[curve]) continue;
      const moved = p[curve].map(([t, v]) => [Math.round(stretch(t, from, to)) % DAY, v]).sort((a, b) => a[0] - b[0]);
      const apart = moved.every((pt, i) => (i + 1 < moved.length ? moved[i + 1][0] : moved[0][0] + DAY) - pt[0] >= gap || moved.length === 1);
      if (apart) p[curve] = moved;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    const p = this._edit?.profile;
    if (!p) return;
    if (el.id === "shape" && el.value) {
      this._shape(el.value);
      return;
    }
    if (el.id === "before" || el.id === "after") {
      const limit = this._status?.limits?.[el.id] ?? (el.id === "before" ? 180 : 240);
      const value = Math.min(limit, Math.max(0, Math.round(Number(el.value) || 0)));
      this._setWindow(el.id === "before" ? value : p.before, el.id === "after" ? value : p.after);
      this._dirty();
      this._render();
      return;
    }
    if (el.id === "assign" && el.value) {
      const kind = el.value.split(":", 1)[0]; // light ids have colons of their own
      p[kind] = [...p[kind], el.value.slice(kind.length + 1)];
      this._dirty();
      this._render();
    }
  }

  _onDown(ev) {
    const point = ev.target.closest?.(".point");
    if (!point || !this.admin) return;
    this._sel = Number(point.dataset.i);
    this._drag = true;
    const plot = this.shadowRoot.getElementById("plot");
    plot?.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    point.focus?.();
    this._renderPlot();
  }

  _onMove(ev) {
    if (!this._drag || this._sel < 0) return;
    const plot = this.shadowRoot.getElementById("plot");
    if (!plot) return;
    const r = plot.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    const n = Math.min(1, Math.max(0, 1 - (fy * 300 - 20) / 260));
    const v = this._active === "colour"
      ? Math.round((KELVIN[0] + n * (KELVIN[1] - KELVIN[0])) / STEP_K) * STEP_K
      : Math.max(1, Math.round(n * 100));
    this._move(this._sel, this._drawnMinute(fx * (DAY - 1)), v);
    this._renderPlot();
  }

  _endDrag() {
    if (!this._drag) return;
    this._drag = false;
    this._render();
  }

  _onKey(ev) {
    const point = ev.target.closest?.(".point");
    if (!point || !this.admin) return;
    const step = { ArrowLeft: [-STEP_MIN, 0], ArrowRight: [STEP_MIN, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
    if (ev.key === "Delete" || ev.key === "Backspace") {
      this._sel = Number(point.dataset.i);
      this._delete();
      ev.preventDefault();
      return;
    }
    if (!step) return;
    ev.preventDefault();
    this._sel = Number(point.dataset.i);
    this._nudge(...step);
  }

  // --- drawing ---------------------------------------------------------------------------------

  _render() {
    const st = this._status;
    if (!st) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="empty">Loading…</div>`;
      return;
    }
    if (st.failed) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="empty">Circadian lighting could not be read: ${esc(st.failed)}</div>`;
      return;
    }
    const focused = this.shadowRoot.activeElement?.id;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="wrap">${this._list()}${this._editor()}</div>`;
    this._renderPlot();
    if (focused) this.shadowRoot.getElementById(focused)?.focus?.();
  }

  _list() {
    const st = this._status;
    const profiles = st.profiles || [];
    const max = st.limits?.profiles ?? 16;
    const current = this._edit?.profile.id;
    const items = profiles.map((p) => {
      const badges = [p.colour ? `<span class="badge warm">Colour</span>` : "", p.dimming ? `<span class="badge dim">Dimming</span>` : "",
        `<span class="badge mode">${{ smooth: "Smooth", steps: "Steps", seasons: "Seasons" }[p.mode]}</span>`].join("");
      const now = [p.kelvin ? `${p.kelvin} K` : "", p.brightness !== null && p.brightness !== undefined ? `${p.brightness} %` : ""].filter(Boolean).join(" · ");
      const used = this._usedBy(p).map((u) => u.name).join(", ") || "Not used yet";
      return `
        <button class="item ${p.id === current ? "on" : ""}" data-action="open" data-id="${esc(p.id)}">
          <span class="item-name">${esc(p.name)}</span>
          <span class="badges">${badges}</span>
          <span class="item-sub">${st.enabled && now ? `Now ${now} · ` : ""}${esc(used)}</span>
        </button>`;
    }).join("");
    const unsaved = this._edit && !this._edit.profile.id
      ? `<div class="item on"><span class="item-name">${esc(this._edit.profile.name)}</span><span class="item-sub">Not saved yet</span></div>` : "";
    return `
      <aside class="list">
        <div class="list-head"><h3>Profiles</h3><span class="sub">${profiles.length} of ${max}</span></div>
        ${items}${unsaved}
        ${this.admin && profiles.length < max && !unsaved ? `<button class="new" data-action="new"><ha-icon icon="mdi:plus"></ha-icon>New profile</button>` : ""}
        ${st.enabled ? "" : `<p class="sub">Circadian lighting is off: turn it on in Settings.</p>`}
      </aside>`;
  }

  /** What follows a profile: [{kind, id, name}]. */
  _usedBy(p) {
    const m = this.master || {};
    const lightName = (id) => {
      const l = (m.lights || []).find((x) => x.id === id);
      return l ? l.name || l.default_name : id;
    };
    return [
      ...(p.lights || []).map((id) => ({ kind: "lights", id, name: `Light · ${lightName(id)}` })),
      ...(p.groups || []).map((id) => ({ kind: "groups", id, name: `Group · ${(m.groups || []).find((g) => g.id === id)?.name || id}` })),
      ...(p.scenes || []).map((id) => ({ kind: "scenes", id, name: `Scene · ${(m.scenes || []).find((s) => s.id === id)?.name || id}` })),
    ];
  }

  _editor() {
    if (!this._edit) {
      return `<section class="editor"><div class="empty">${this.admin ? "No profile yet: make one with New profile." : "No profile yet."}</div></section>`;
    }
    const p = this._edit.profile;
    const lock = this.admin && !this._busy ? "" : "disabled";
    const tab = (curve, label) => p[curve]
      ? `<button class="pill ${this._active === curve ? "on" : ""}" data-action="curve" data-curve="${curve}" aria-pressed="${this._active === curve}"
           style="--c: ${COLOURS[curve]}"><span class="dot"></span>${label}</button>`
      : (this.admin ? `<button class="pill add" data-action="add-curve" data-curve="${curve}" style="--c: ${COLOURS[curve]}" ${lock}><ha-icon icon="mdi:plus"></ha-icon>Add ${label.toLowerCase()}</button>` : "");
    const mode = (value, icon, label) =>
      `<button class="seg ${p.mode === value ? "on" : ""}" data-action="mode" data-mode="${value}" aria-pressed="${p.mode === value}" ${lock}>${icon}${label}</button>`;
    const shapes = this._active === "colour" && this.admin
      ? `<select id="shape" aria-label="Shape the colour temperature curve from the location" ${lock}>
          <option value="">Shape from location…</option>
          ${Object.entries(SHAPE_NAMES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
        </select>` : "";
    const max = this._status.limits?.points ?? 25;
    const edge = (key, label) => `
      <div class="stepper">
        <button class="sq" data-action="window" data-key="${key}" data-d="${-STEP_SEASON}" aria-label="${STEP_SEASON} minutes less ${label}" ${lock || (p[key] <= 0 ? "disabled" : "")}>−</button>
        <span class="val"><span>${p[key]} min</span><small>${label}</small></span>
        <button class="sq" data-action="window" data-key="${key}" data-d="${STEP_SEASON}" aria-label="${STEP_SEASON} minutes more ${label}" ${lock || (p[key] >= (this._status.limits?.[key] ?? (key === "before" ? 180 : 240)) ? "disabled" : "")}>+</button>
      </div>`;
    const seasons = p.mode === "seasons" ? `
      <div class="seasons">${edge("before", "before sunrise")}${edge("after", "after sunset")}</div>` : "";
    const used = this._usedBy(p);
    const options = this._assignable(p);
    const days = this._status.days || [];
    const shown = this._shownDay();
    const dayText = shown.sunrise !== null || shown.sunset !== null
      ? `${this._day === "today" ? "Today" : `21 ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][this._day]}`}${this._status.place_name ? ` in ${esc(this._status.place_name)}` : ""}: sunrise ${esc(clock(shown.sunrise ?? 0))}, sunset ${shown.sunset === null ? "after midnight" : esc(clock(shown.sunset))}.${p.mode === "seasons" ? " Dashed: as drawn." : " Not following the seasons: the clock times stay."}`
      : "No location yet: Settings → Circadian lighting.";
    return `
      <section class="editor">
        <div class="row">
          <label class="field grow"><span>Profile name</span><input id="name" maxlength="40" value="${esc(p.name)}" ${lock}></label>
          <div class="pills" role="group" aria-label="Curve to edit">${tab("colour", "Colour temperature")}${tab("dimming", "Dimming")}</div>
        </div>
        <div class="toolbar">
          <div class="segs" role="group" aria-label="How the curve runs">
            ${mode("smooth", ICONS.smooth, "Smooth")}${mode("steps", ICONS.steps, "Steps")}${mode("seasons", ICONS.seasons, "Follow the seasons")}
          </div>
          <div class="grow"></div>
          ${shapes}
          ${this.admin ? `<button class="btn" data-action="add-point" ${lock || (this._points.length >= max ? "disabled" : "")}><ha-icon icon="mdi:plus"></ha-icon>Add point</button>` : ""}
        </div>
        ${seasons}
        <div class="graph">
          <div class="scale left" aria-hidden="true" id="scale-left"></div>
          <div class="plot-wrap">
            <div id="plot" class="plot" data-action="plot"></div>
            <div class="hours" aria-hidden="true">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) =>
              `<span style="left: ${(h / 24) * 100}%">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>
          </div>
          <div class="scale right" aria-hidden="true" id="scale-right"></div>
        </div>
        <div class="inspector" id="inspector"></div>
        <div class="days">
          <div class="sub"><b>Show a day</b> · ${dayText}</div>
          <div class="day-buttons" role="group" aria-label="Day shown">
            <button class="day ${this._day === "today" ? "on" : ""}" data-action="day" data-day="today" aria-pressed="${this._day === "today"}">Today</button>
            ${days.map((_d, i) => `<button class="day ${this._day === i ? "on" : ""}" data-action="day" data-day="${i}" aria-pressed="${this._day === i}">${MONTHS[i]}</button>`).join("")}
          </div>
        </div>
        <div class="used">
          <div><b>Used by</b></div>
          <div class="chips">
            ${used.map((u) => `<span class="chip">${esc(u.name)}${this.admin ? `<button class="x" data-action="unassign" data-kind="${u.kind}" data-id="${esc(u.id)}" aria-label="Stop ${esc(u.name)} following it" ${lock}><ha-icon icon="mdi:close"></ha-icon></button>` : ""}</span>`).join("")}
            ${!used.length ? `<span class="sub">Nothing follows it yet.</span>` : ""}
            ${this.admin && options.length ? `<select id="assign" aria-label="Apply to a light, group or scene" ${lock}>
              <option value="">Apply to a light, group or scene…</option>
              ${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}${o.why ? ` · ${esc(o.why)}` : ""}</option>`).join("")}
            </select>` : ""}
          </div>
          <div class="sub">One that follows another profile moves to this one when you save. A scene recalled with this profile makes the lights it switches on follow it, until they are changed by hand or switched off.</div>
        </div>
        <div class="foot">
          <span class="sub" id="store"></span>
          <div class="grow"></div>
          ${this.admin ? `
            <button class="btn secondary danger" data-action="delete" ${lock}>Delete profile</button>
            <button class="btn secondary" data-action="revert" ${lock || (this._edit.dirty ? "" : "disabled")}>Revert</button>
            <button class="btn" data-action="save" ${lock || (this._edit.dirty ? "" : "disabled")}>${this._busy ? "Saving…" : "Save"}</button>` : ""}
        </div>
      </section>`;
  }

  /** The lights, groups and scenes no profile has yet: what this one can be applied to. */
  _assignable(p) {
    const m = this.master || {};
    // Each light, group and scene; one that follows another profile moves to this one when it is saved (one
    // profile each). A dimmable light only with a dimming curve: it takes only a profile's dimming.
    const owner = new Map();
    for (const other of (this._status.profiles || []).filter((x) => x.id !== p.id)) {
      for (const kind of ["lights", "groups", "scenes"]) for (const id of other[kind] || []) owner.set(`${kind}:${id}`, other.name);
    }
    const mine = new Set(["lights", "groups", "scenes"].flatMap((kind) => (p[kind] || []).map((id) => `${kind}:${id}`)));
    const why = (value) => (owner.has(value) ? `follows ${owner.get(value)}` : "");
    return [
      ...(m.lights || []).filter((l) => p.dimming || l.kind === "tunable_white").map((l) => ({ value: `lights:${l.id}`, label: `Light · ${l.name || l.default_name}` })),
      ...(m.groups || []).map((g) => ({ value: `groups:${g.id}`, label: `Group · ${g.name}` })),
      ...(m.scenes || []).map((s) => ({ value: `scenes:${s.id}`, label: `Scene · ${s.name}` })),
    ].filter((o) => !mine.has(o.value)).map((o) => ({ ...o, why: why(o.value) }));
  }

  /** The graph, the point being edited and the size: drawn again while a point is dragged. */
  _renderPlot() {
    const plot = this.shadowRoot.getElementById("plot");
    if (!plot || !this._edit) return;
    const p = this._edit.profile;
    const active = this._active;
    const other = active === "colour" ? "dimming" : "colour";
    const shown = this._shownDay();
    const pct = (t) => `${((t / DAY) * 100).toFixed(2)}%`;
    let marks = "";
    if (shown.sunrise !== null) marks += `<div class="night" style="left: 0; width: ${pct(shown.sunrise)}"></div><div class="sun" style="left: ${pct(shown.sunrise)}"><span>sunrise ${clock(shown.sunrise)}</span></div>`;
    if (shown.sunset !== null) marks += `<div class="night" style="left: ${pct(shown.sunset)}; right: 0"></div><div class="sun end" style="left: ${pct(shown.sunset)}"><span>sunset ${clock(shown.sunset)}</span></div>`;
    const w = this._windows();
    if (w) {
      marks += `<div class="window" style="left: ${pct(Math.max(0, w.real[0]))}"><span>day starts ${clock(w.real[0])}</span></div>
        <div class="window end" style="left: ${pct(Math.min(DAY - 1, w.real[1]))}"><span>day ends ${clock(w.real[1])}</span></div>`;
    }
    const now = minutes(this._status.now);
    if (shown.today && now !== null) marks += `<div class="now" style="left: ${pct(now)}"><span>now</span></div>`;
    const ghost = p.mode === "seasons" && w ? this._path(active, true) : "";
    const points = (p[active] || []).map((pt, i) => {
      const left = pct(this._shown(pt[0]));
      const top = `${(this._y(active, pt[1]) / 3).toFixed(2)}%`;
      const label = `${clock(this._shown(pt[0]))} · ${this._label(active, pt[1])}`;
      return `<button class="point ${i === this._sel ? "sel" : ""}" data-i="${i}" style="left: ${left}; top: ${top}; --c: ${COLOURS[active]}"
          aria-label="Point ${i + 1}, ${label}" ${this.admin ? "" : "tabindex='-1'"}><span></span></button>
        ${i === this._sel ? `<span class="tip" style="left: ${left}; top: ${top}">${label}</span>` : ""}`;
    }).join("");
    plot.innerHTML = `
      ${marks}
      <svg viewBox="0 0 1440 300" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20H1440M0 85H1440M0 150H1440M0 215H1440M0 280H1440" class="grid"></path>
        ${p[other] ? `<path d="${this._path(other, false)}" stroke="${COLOURS[other]}" class="faint"></path>` : ""}
        ${ghost ? `<path d="${ghost}" stroke="${COLOURS[active]}" class="ghost"></path>` : ""}
        <path d="${this._path(active, false)}" stroke="${COLOURS[active]}" class="line"></path>
      </svg>
      ${points}`;
    if (this._pointFocus && this._sel >= 0) plot.querySelector(`.point[data-i="${this._sel}"]`)?.focus({ preventScroll: true });
    const scale = (curve, values) => p[curve]
      ? values.map((v) => `<span style="top: ${(this._y(curve, v) / 3).toFixed(2)}%; color: ${active === curve ? COLOURS[curve] : "var(--secondary-text-color)"}">${this._label(curve, v)}</span>`).join("")
      : "";
    this.shadowRoot.getElementById("scale-left").innerHTML = scale("colour", [1000, 2000, 3000, 4000, 5000, 6500]);
    this.shadowRoot.getElementById("scale-right").innerHTML = scale("dimming", [0, 25, 50, 75, 100]);
    this._renderInspector();
    const parts = [p.colour ? `${p.colour.length} colour temperature point${p.colour.length === 1 ? "" : "s"}` : "",
      p.dimming ? `${p.dimming.length} dimming point${p.dimming.length === 1 ? "" : "s"}` : ""].filter(Boolean);
    const store = this.shadowRoot.getElementById("store");
    if (store) store.textContent = `${parts.join(" + ")}${this._edit.dirty ? " · not saved" : ""}`;
  }

  _renderInspector() {
    const box = this.shadowRoot.getElementById("inspector");
    if (!box) return;
    const points = this._points;
    const max = this._status.limits?.points ?? 25;
    const pt = points[this._sel];
    const lock = this.admin && !this._busy ? "" : "disabled";
    if (!pt) {
      const other = this._active === "colour" ? "dimming" : "colour";
      box.innerHTML = `<span class="sub">${this.admin ? "Click a point to see its value, drag it to move it (arrow keys too)." : "The profile's curve."} ${points.length} of ${max} points.</span>
        <div class="grow"></div>
        ${this.admin && this._edit.profile[other] ? `<button class="btn secondary" data-action="remove-curve" ${lock}>Remove the ${this._active === "colour" ? "colour temperature" : "dimming"} curve</button>` : ""}`;
      return;
    }
    const shownTime = clock(this._shown(pt[0]));
    const stepper = (dt, dv, text, less, more) => `
      <div class="stepper">
        <button class="sq" data-action="nudge" data-dt="${-dt}" data-dv="${-dv}" aria-label="${less}" ${lock}>−</button>
        <span class="val">${text}</span>
        <button class="sq" data-action="nudge" data-dt="${dt}" data-dv="${dv}" aria-label="${more}" ${lock}>+</button>
      </div>`;
    box.innerHTML = `
      <b>Point ${this._sel + 1} of ${points.length}</b>
      ${stepper(STEP_MIN, 0, shownTime, `${STEP_MIN} minutes earlier`, `${STEP_MIN} minutes later`)}
      ${stepper(0, 1, this._label(this._active, pt[1]), "Lower", "Higher")}
      <div class="grow"></div>
      ${this.admin ? `<button class="btn secondary danger" data-action="delete-point" ${lock || (points.length <= 1 ? "disabled" : "")}><ha-icon icon="mdi:delete-outline"></ha-icon>Delete point</button>` : ""}`;
  }
}

const ICONS = {
  smooth: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17c4 0 4-10 9-10s5 10 9 10"></path></svg>`,
  steps: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h5v-6h5V6h8"></path></svg>`,
  seasons: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 8v3M5.5 11.5l1.8 1.8M18.5 11.5l-1.8 1.8M12 3v1"></path></svg>`,
};

const STYLE = `
  :host { display: block; --line: var(--divider-color, rgba(0,0,0,.12)); --card: var(--ha-card-background, var(--card-background-color, #fff));
    --soft: rgba(127, 127, 127, .08); --night: rgba(127, 127, 127, .10); --mdc-icon-size: 18px; }
  * { box-sizing: border-box; }
  .wrap { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .empty { padding: 32px 16px; text-align: center; color: var(--secondary-text-color); }
  .sub { color: var(--secondary-text-color); font-size: 13px; }
  h3 { margin: 0; font-size: 16px; font-weight: 500; }
  .list { flex: 1 1 240px; max-width: 300px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .list-head { display: flex; justify-content: space-between; align-items: baseline; }
  .item { text-align: left; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; }
  .item.on { border-color: var(--primary-color); box-shadow: inset 0 0 0 1px var(--primary-color); }
  .item-name { font-weight: 500; }
  .item-sub { font-size: 12px; color: var(--secondary-text-color); }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--soft); }
  .badge.warm { background: rgba(242, 169, 0, .2); }
  .badge.dim { background: color-mix(in srgb, var(--primary-color) 13%, transparent); }
  .badge.mode { --mode: var(--success-color, #43a047); background: color-mix(in srgb, var(--mode) 13%, transparent); }
  .new { font: inherit; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px; border: 1px dashed var(--line);
    border-radius: 10px; background: none; color: var(--primary-color); cursor: pointer; font-weight: 500; }
  .editor { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .row, .toolbar, .foot, .inspector, .seasons { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1 1 0; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
  .field span { font-size: 12px; color: var(--secondary-text-color); }
  input, select { font: inherit; color: var(--primary-text-color); background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; padding: 8px 10px; }
  #name { font-size: 18px; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { font: inherit; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px; border-radius: 20px; cursor: pointer;
    border: 1px solid var(--line); background: var(--soft); color: var(--secondary-text-color); }
  .pill.on { border: 2px solid var(--c); background: var(--card); color: var(--primary-text-color); font-weight: 500; }
  .pill.add { border: 1px dashed var(--c); background: none; color: var(--c); }
  .dot { width: 10px; height: 10px; border-radius: 5px; background: var(--c); }
  .toolbar { padding: 8px; background: var(--soft); border-radius: 10px; }
  .segs { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--card); }
  .seg { font: inherit; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px; border: 0; cursor: pointer;
    background: none; color: var(--primary-text-color); }
  .seg + .seg { border-left: 1px solid var(--line); }
  .seg.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .seg svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .btn { font: inherit; display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 14px; border-radius: 8px; cursor: pointer;
    border: 0; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500; }
  .btn.secondary { background: var(--card); color: var(--primary-text-color); border: 1px solid var(--line); font-weight: 400; }
  .btn.danger { color: var(--error-color, #db4437); }
  .btn:disabled, .seg:disabled, select:disabled, input:disabled { opacity: .5; cursor: default; }
  .seasons { display: flex; gap: 8px; flex-wrap: wrap; }
  .graph { display: flex; gap: 6px; }
  .scale { position: relative; width: 52px; height: 320px; flex: none; font-size: 12px; }
  .scale span { position: absolute; transform: translateY(-50%); white-space: nowrap; }
  .scale.left span { right: 4px; }
  .scale.right { width: 44px; }
  .scale.right span { left: 4px; }
  .plot-wrap { flex: 1 1 0; min-width: 0; }
  .plot { position: relative; height: 320px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); touch-action: none; }
  .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .plot path { fill: none; vector-effect: non-scaling-stroke; }
  .plot .grid { stroke: var(--line); stroke-width: 1; }
  .plot .line { stroke-width: 3; }
  .plot .faint { stroke-width: 2; opacity: .35; }
  .plot .ghost { stroke-width: 2; stroke-dasharray: 6 6; opacity: .45; }
  .night { position: absolute; top: 0; bottom: 0; background: var(--night); }
  .sun, .window, .now { position: absolute; top: 0; bottom: 0; border-left: 1px solid #c27c00; }
  .window { border-left: 2px dashed var(--primary-color); }
  .now { border-left: 2px solid var(--primary-text-color); opacity: .6; }
  .sun span, .window span, .now span { position: absolute; font-size: 11px; white-space: nowrap; color: var(--secondary-text-color); padding: 0 4px; }
  .sun span { top: 4px; }
  .sun.end span { right: 0; }
  .window span { bottom: 4px; right: 0; background: var(--card); }
  .window.end span { left: 0; right: auto; }
  .now span { bottom: 22px; }
  .point { position: absolute; width: 40px; height: 40px; margin: -20px 0 0 -20px; padding: 0; border: 0; background: none;
    cursor: grab; display: flex; align-items: center; justify-content: center; touch-action: none; }
  .point span { width: 16px; height: 16px; border-radius: 50%; background: var(--c); border: 2px solid var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  .point.sel span { width: 22px; height: 22px; background: var(--card); border: 5px solid var(--c); box-shadow: 0 0 0 6px rgba(127,127,127,.18); }
  .point:focus-visible { outline: 2px solid var(--primary-color); border-radius: 50%; }
  .tip { position: absolute; transform: translate(-50%, -46px); background: var(--primary-text-color); color: var(--card); font-size: 12px;
    padding: 4px 8px; border-radius: 6px; white-space: nowrap; pointer-events: none; }
  .hours { position: relative; height: 22px; font-size: 12px; color: var(--secondary-text-color); }
  .hours span { position: absolute; top: 4px; transform: translateX(-50%); }
  .inspector { min-height: 56px; padding: 8px 12px; border-radius: 10px; background: var(--soft); }
  .stepper { display: flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
  .sq { font: inherit; font-size: 20px; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 8px; cursor: pointer;
    background: rgba(127, 127, 127, .12); color: var(--primary-text-color); display: flex; align-items: center; justify-content: center; }
  .sq:disabled { opacity: .4; cursor: default; }
  .val { min-width: 96px; text-align: center; font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums;
    display: flex; flex-direction: column; line-height: 1.2; }
  .val small { font-size: 12px; font-weight: 400; color: var(--secondary-text-color); }
  .days { display: flex; flex-direction: column; gap: 8px; }
  .day-buttons { display: grid; grid-template-columns: repeat(13, minmax(0, 1fr)); gap: 4px; }
  .day { font: inherit; font-size: 13px; height: 36px; border-radius: 6px; cursor: pointer; border: 1px solid var(--line); background: var(--card); color: var(--primary-text-color); padding: 0; }
  .day.on { border-color: var(--primary-color); background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .used { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 14px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 0 6px 0 12px; border-radius: 16px; background: var(--soft); }
  .x { border: 0; background: none; color: var(--secondary-text-color); cursor: pointer; display: flex; padding: 4px; border-radius: 50%; }
  .foot { border-top: 1px solid var(--line); padding-top: 14px; }
  @media (max-width: 600px) {
    .list { max-width: none; }
    .day-buttons { grid-template-columns: repeat(7, minmax(0, 1fr)); }
    .scale { width: 40px; }
    .scale.right { width: 36px; }
  }
`;

customElements.define("netroni-circadian", NetroniCircadian);
