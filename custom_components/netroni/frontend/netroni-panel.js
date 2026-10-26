// Netroni sidebar panel: installation overview, groups, commissioning and the DMX monitor.
//
// A plain web component (no build step). Home Assistant sets `hass` and `narrow`; the structure
// comes from the integration's "netroni/subscribe" WebSocket subscription and live light states
// from hass.states. Everyone can look and use Identify; changes need an administrator (the
// WebSocket commands enforce it, the panel only hides the controls).

const HIGHLIGHT_MS = 60_000; // how long a port that identified itself stays highlighted
const MATTER_POLL_S = 10;
const DMX_POLL_MS = 250;
const DMX_SLOTS = 512;
const DMX_BLOCK = 32; // every XP-Mini owns 32 slots: 16 outputs, 2 slots each at 16-bit

const APP_ICONS = {
  SmartThings: "mdi:hub-outline",
  "Google Home": "mdi:google-home",
  "Amazon Alexa": "mdi:amazon-alexa",
  "Apple Home": "mdi:apple",
  "Home Assistant": "mdi:home-assistant",
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Colour ranges of tunable-white strips; the first is the default (Visiolite strips).
const CCT_DEFAULT = [2200, 5000];
const CCT_PRESETS = [
  { label: "Visiolite strip", range: CCT_DEFAULT },
  { label: "Warm to daylight", range: [2700, 6500] },
  { label: "Warm to cool", range: [3000, 6000] },
];
const cctLabel = ([warm, cool]) => `${warm}–${cool} K`;

const portOf = (light) => Number(/^port(\d+)/.exec(light.key)?.[1]);
const tagOf = (light) => light.key.replace(/^port/, "").toUpperCase(); // "3A", "3T"

class NetroniPanel extends HTMLElement {
  constructor() {
    super();
    this._tab = "installation";
    this._data = null; // {masters: [...]} from netroni/subscribe
    this._error = null;
    this._dialog = null; // the open dialog: {kind, ...}
    this._identified = new Map(); // "entry|uid|port" -> {lightIds, until}
    this._matter = {}; // entry_id -> status from netroni/matter_status
    this._windowClosesAt = {}; // entry_id -> ms, when the open pairing window closes (from the bridge)
    this._dmx = {}; // entry_id -> netroni/dmx_snapshot result (plus fps, measured here)
    this._dmxPct = false; // show values as % instead of 0-255
    this._dmxSel = null; // "entry|address" of the channel shown in the info line
    this._dmxSig = ""; // what the rendered grids are built from; a change means a full re-render
    this._busy = false;
    this._focusMini = new URLSearchParams(location.search).get("mini"); // from a device page's "Configure"
    this._stateSig = "";
    this._ticks = 0;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div id="main"></div><div id="dialog"></div>`;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("input", (ev) => {
      if (ev.target.id !== "cct-warm" && ev.target.id !== "cct-cool") return;
      const { warm, cool } = this._cctInputs();
      Object.assign(this._dialog, { warm, cool, custom: true });
      const labels = this.shadowRoot.getElementById("cct-labels");
      if (labels && warm && cool) labels.innerHTML = this._cctLabels(warm, cool);
    });
    this.shadowRoot.addEventListener("mouseover", (ev) => {
      const cell = ev.target.closest?.(".dmx-grid .dmx-cell");
      if (cell) this._selectSlot(cell.dataset.entry, Number(cell.dataset.addr));
    });
    this.shadowRoot.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this._dialog) this._closeDialog();
      if (ev.key === "Enter" && ev.target.matches?.("input") && this._dialog?.kind === "edit") this._saveLight();
    });
  }

  // --- Home Assistant interface -------------------------------------------------------------

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._subscribe();
    const sig = this._stateSignature();
    if (sig !== this._stateSig) {
      this._stateSig = sig;
      this._renderMain();
    }
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._renderMain();
  }

  set panel(_panel) {}
  set route(_route) {}

  connectedCallback() {
    // Home Assistant may keep the panel element between visits: look at the link again each time.
    const focus = new URLSearchParams(location.search).get("mini");
    if (focus) {
      this._focusMini = focus;
      this._tab = "installation";
      this._renderMain();
    }
    if (this._hass && !this._unsub) this._subscribe();
    this._timer = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._stopDmxPoll();
    this._unsub?.then((unsub) => unsub()).catch(() => {});
    this._unsub = null;
  }

  get _admin() {
    return Boolean(this._hass?.user?.is_admin);
  }

  _subscribe() {
    this._unsub = this._hass.connection.subscribeMessage((msg) => this._onMessage(msg), {
      type: "netroni/subscribe",
    });
    this._unsub.catch((err) => {
      this._error = err.message || String(err);
      this._renderMain();
    });
  }

  _onMessage(msg) {
    if (msg.kind === "overview") {
      this._data = msg.data;
      this._error = null;
      this._renderMain();
      if (this._tab === "matter") this._refreshMatter();
      if (this._tab !== "dmx") this._refreshDmx(); // is there DMX output to show a tab for?
    } else if (msg.kind === "identified") {
      this._onIdentified(msg);
    }
  }

  /** What a re-render depends on besides the overview: light states and the user's rights. */
  _stateSignature() {
    if (!this._data || !this._hass) return "";
    const parts = [this._admin];
    for (const master of this._data.masters) {
      for (const light of master.lights) {
        const st = this._hass.states[light.entity_id];
        parts.push(st ? `${st.state}/${st.attributes.brightness}/${st.attributes.color_temp_kelvin}` : "-");
      }
      for (const group of master.groups || []) {
        const st = this._hass.states[group.entity_id];
        parts.push(st ? `${st.state}/${st.attributes.brightness}` : "-");
      }
    }
    return parts.join("|");
  }

  _tick() {
    this._ticks += 1;
    const now = Date.now();
    let expired = false;
    for (const [key, item] of this._identified) {
      if (item.until <= now) {
        this._identified.delete(key);
        expired = true;
      }
    }
    if (expired) this._renderMain();
    if (this._tab === "matter") {
      this._updateCountdowns();
      if (this._ticks % MATTER_POLL_S === 0) this._refreshMatter();
    }
  }

  // --- events and actions -------------------------------------------------------------------

  _onIdentified(msg) {
    const key = `${msg.entry_id}|${msg.uid}|${msg.port}`;
    this._identified.set(key, { lightIds: msg.light_ids || [], until: Date.now() + HIGHLIGHT_MS });
    this._tab = "installation";
    this._stopDmxPoll();
    this._renderMain();
    requestAnimationFrame(() =>
      this.shadowRoot.getElementById(`port-${msg.uid}-${msg.port}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
    const master = this._master(msg.entry_id);
    const light = master?.lights.find((l) => (msg.light_ids || []).includes(l.id));
    if (light && this._admin && !this._dialog) this._openEdit(msg.entry_id, light, true);
    else if (light) this._toast(`${light.default_name} of ${this._miniName(master, msg.uid)} identified itself`);
  }

  _onClick(ev) {
    const el = ev.target.closest?.("[data-action]");
    if (!el || el.disabled) return;
    const d = el.dataset;
    switch (d.action) {
      case "menu":
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
        break;
      case "tab":
        this._tab = d.tab;
        this._renderMain();
        if (this._tab === "matter") this._refreshMatter();
        if (this._tab === "dmx") this._startDmxPoll();
        else this._stopDmxPoll();
        break;
      case "dmx-slot":
        this._selectSlot(d.entry, Number(d.addr));
        break;
      case "device":
        history.pushState(null, "", `/config/devices/device/${d.device}`);
        window.dispatchEvent(new CustomEvent("location-changed"));
        break;
      case "more-info":
        if (d.entity) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: d.entity }, bubbles: true, composed: true }));
        break;
      case "toggle":
        this._hass
          .callService("light", "toggle", { entity_id: d.entity })
          .catch((err) => this._toast(err.message || String(err)));
        break;
      case "identify":
        this._identify(d.entry, d.uid, Number(d.port));
        break;
      case "edit": {
        const light = this._master(d.entry)?.lights.find((l) => l.id === d.light);
        if (light) this._openEdit(d.entry, light, false);
        break;
      }
      case "save-light":
        this._saveLight();
        break;
      case "remove":
        this._openDialog({ kind: "remove", entry: d.entry, uid: d.uid });
        break;
      case "confirm-remove":
        this._removeMini();
        break;
      case "mini-actions":
        this._openDialog({ kind: "mini-actions", entry: d.entry, uid: d.uid });
        break;
      case "restart":
        this._closeDialog();
        this._restartMini(d.entry, d.uid);
        break;
      case "reset":
        this._openDialog({ kind: "reset", entry: d.entry, uid: d.uid });
        break;
      case "confirm-reset":
        this._resetMini();
        break;
      case "replace":
        this._openDialog({ kind: "replace", entry: d.entry, uid: d.uid });
        break;
      case "confirm-replace":
        this._replaceMini();
        break;
      case "cct": {
        const mini = this._mini(d.entry, d.uid);
        const range = this._cctRange(this._master(d.entry), mini, Number(d.port));
        this._openDialog({ kind: "cct", entry: d.entry, uid: d.uid, port: Number(d.port), warm: range[0], cool: range[1] });
        break;
      }
      case "goto-group":
        ev.stopPropagation();
        this._tab = "groups";
        this._stopDmxPoll();
        this._gotoGroup = `${d.entry}|${d.group}`;
        this._renderMain();
        requestAnimationFrame(() =>
          this.shadowRoot.getElementById(`group-${d.entry}-${d.group}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
        );
        clearTimeout(this._gotoTimer);
        this._gotoTimer = setTimeout(() => {
          this._gotoGroup = null;
          this._renderMain();
        }, 2500);
        break;
      case "new-group":
        this._openDialog({ kind: "group", entry: d.entry, groupId: null, name: "", members: [], areaId: null, areaTouched: false, hideMembers: true });
        break;
      case "edit-group": {
        const group = this._master(d.entry)?.groups.find((g) => g.id === d.group);
        if (group) this._openDialog({ kind: "group", entry: d.entry, groupId: group.id, name: group.name, members: [...group.members], areaId: group.area_id, areaTouched: true, hideMembers: group.hide_members !== false });
        break;
      }
      case "save-group":
        this._saveGroup();
        break;
      case "delete-group":
        this._deleteGroup();
        break;
      case "save-cct":
        this._saveCct();
        break;
      case "confirm-pairs":
        this._setPairs();
        break;
      case "pair-app":
        this._openWindow(d.entry);
        break;
      case "cancel-pairing":
        this._closeWindow(d.entry);
        break;
      case "scrim":
        if (ev.target === el) this._closeDialog();
        break;
      case "close-dialog":
        this._closeDialog();
        break;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (el.dataset?.action === "dim") {
      const brightness = Math.max(1, Math.min(255, Number(el.value)));
      this._hass
        .callService("light", "turn_on", { entity_id: el.dataset.entity, brightness })
        .catch((err) => this._toast(err.message || String(err)));
      return;
    }
    if (el.dataset?.action === "member") {
      if (!this._dialog) return;
      const id = el.dataset.light;
      this._dialog.members = el.checked ? [...this._dialog.members, id] : this._dialog.members.filter((m) => m !== id);
      if (!this._dialog.areaTouched) {
        this._dialog.areaId = this._commonArea(this._dialog.entry, this._dialog.members);
        const select = this.shadowRoot.getElementById("group-area");
        if (select) select.value = this._dialog.areaId || "";
      }
      return;
    }
    if (el.id === "group-hide") {
      this._dialog.hideMembers = el.checked;
      return;
    }
    if (el.id === "group-area") {
      this._dialog.areaId = el.value || null;
      this._dialog.areaTouched = true;
      return;
    }
    if (el.id === "cct-preset") {
      const preset = CCT_PRESETS[Number(el.value)];
      if (preset) {
        this._dialog.warm = preset.range[0];
        this._dialog.cool = preset.range[1];
      }
      this._dialog.custom = !preset;
      this._renderDialog();
      return;
    }
    if (el.dataset?.action === "dmx-unit") {
      this._dmxPct = el.value === "pct";
      this._updateDmx();
      return;
    }
    if (el.dataset?.action !== "tw") return;
    const make = el.checked;
    el.checked = !make; // only the confirmed change counts
    this._openDialog({ kind: "pairs", entry: el.dataset.entry, uid: el.dataset.uid, port: Number(el.dataset.port), make });
  }

  async _call(msg) {
    try {
      return await this._hass.callWS(msg);
    } catch (err) {
      this._toast(err.message || String(err));
      throw err;
    }
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  async _identify(entry, uid, port) {
    try {
      await this._call({ type: "netroni/identify", entry_id: entry, uid, port });
      this._toast(`Port ${port}A and ${port}B are flashing`);
    } catch {}
  }

  _openEdit(entry, light, identified) {
    this._openDialog({ kind: "edit", entry, light, identified });
    requestAnimationFrame(() => this.shadowRoot.getElementById("light-name")?.focus());
  }

  async _saveLight() {
    const { light } = this._dialog;
    const name = this.shadowRoot.getElementById("light-name").value;
    const area = this.shadowRoot.getElementById("light-area").value || null;
    await this._run(() => this._call({ type: "netroni/update_light", entity_id: light.entity_id, name, area_id: area }));
  }

  async _saveGroup() {
    const d = this._dialog;
    const name = (this.shadowRoot.getElementById("group-name")?.value || "").trim();
    if (!name) {
      this._toast("Give the group a name");
      return;
    }
    d.name = name;
    const msg = { type: "netroni/group_save", entry_id: d.entry, name, members: d.members, area_id: d.areaId || null, hide_members: d.hideMembers !== false };
    if (d.groupId) msg.group_id = d.groupId;
    await this._run(() => this._call(msg));
  }

  /** The area all these lights share (their own or their XP-Mini's), or null. */
  _commonArea(entry, members) {
    const lights = (this._master(entry)?.lights || []).filter((l) => members.includes(l.id));
    const areas = new Set(lights.map((l) => l.area_id || null));
    return lights.length && areas.size === 1 ? [...areas][0] : null;
  }

  async _deleteGroup() {
    const d = this._dialog;
    if (!d.confirmDelete) {
      d.confirmDelete = true; // second click deletes
      this._renderDialog();
      return;
    }
    await this._run(() => this._call({ type: "netroni/group_delete", entry_id: d.entry, group_id: d.groupId }));
  }

  _cctInputs() {
    const warm = Number(this.shadowRoot.getElementById("cct-warm")?.value);
    const cool = Number(this.shadowRoot.getElementById("cct-cool")?.value);
    const valid = Number.isInteger(warm) && Number.isInteger(cool) && warm >= 1000 && cool <= 10000 && cool - warm >= 100;
    return { warm, cool, valid };
  }

  async _saveCct() {
    const { entry, uid, port } = this._dialog;
    const { warm, cool, valid } = this._cctInputs();
    if (!valid) {
      this._toast("Warm must be at least 100 K below cool, both between 1000 and 10000 K");
      return;
    }
    await this._run(() => this._call({ type: "netroni/set_cct_range", entry_id: entry, uid, port, warm, cool }));
  }

  async _setPairs() {
    const { entry, uid, port, make } = this._dialog;
    const mini = this._mini(entry, uid);
    const pairs = new Set(mini.pairs);
    if (make) pairs.add(port);
    else pairs.delete(port);
    await this._run(() => this._call({ type: "netroni/set_pairs", entry_id: entry, uid, pairs: [...pairs] }));
  }

  async _removeMini() {
    const { entry, uid } = this._dialog;
    await this._run(() => this._call({ type: "netroni/remove_mini", entry_id: entry, uid }));
  }

  async _restartMini(entry, uid) {
    try {
      await this._call({ type: "netroni/restart_mini", entry_id: entry, uid });
      this._toast(`${this._miniName(this._master(entry), uid)} is restarting`);
    } catch {}
  }

  async _resetMini() {
    const { entry, uid } = this._dialog;
    const name = this._miniName(this._master(entry), uid);
    await this._run(async () => {
      const result = await this._call({ type: "netroni/factory_reset_mini", entry_id: entry, uid });
      this._toast(result?.found_again ? `${name} was reset: back as a new XP-Mini at DMX ${result.dmx_start}` : `${name} was reset`);
    });
  }

  async _replaceMini() {
    const { entry, uid } = this._dialog;
    const unit = this.shadowRoot.getElementById("replace-new")?.value;
    if (!unit) return;
    const name = this._miniName(this._master(entry), uid);
    await this._run(async () => {
      await this._call({ type: "netroni/replace_mini", entry_id: entry, old: uid, new: unit });
      this._toast(`${name} now runs on the new XP-Mini`);
    });
  }

  /** Run a dialog's action; close the dialog when it worked, keep it open (with the error toast) otherwise. */
  async _run(action) {
    this._busy = true;
    this._renderDialog();
    try {
      await action();
      this._busy = false;
      this._closeDialog();
    } catch {
      this._busy = false;
      this._renderDialog();
    }
  }

  async _refreshMatter() {
    for (const master of this._data?.masters || []) {
      try {
        const status = await this._hass.callWS({ type: "netroni/matter_status", entry_id: master.entry_id });
        this._setMatter(master.entry_id, status);
      } catch (err) {
        this._matter[master.entry_id] = { error: err.message || String(err) };
      }
    }
    if (this._tab === "matter") this._renderMain();
  }

  async _openWindow(entry) {
    this._matter[entry] = { ...this._matter[entry], opening: true };
    this._renderMain();
    try {
      this._setMatter(entry, await this._call({ type: "netroni/matter_open_window", entry_id: entry }));
    } catch {
      this._matter[entry] = { ...this._matter[entry], opening: false };
    }
    this._renderMain();
  }

  async _closeWindow(entry) {
    this._matter[entry] = { ...this._matter[entry], closing: true };
    this._renderMain();
    try {
      await this._call({ type: "netroni/matter_close_window", entry_id: entry });
    } catch {}
    await this._refreshMatter();
  }

  _setMatter(entry, status) {
    this._matter[entry] = status;
    if (status.window_open && status.window_seconds_left != null) {
      this._windowClosesAt[entry] = Date.now() + status.window_seconds_left * 1000;
    } else {
      delete this._windowClosesAt[entry];
    }
  }

  _updateCountdowns() {
    let closed = false;
    for (const [entry, closesAt] of Object.entries(this._windowClosesAt)) {
      const left = Math.max(0, Math.round((closesAt - Date.now()) / 1000));
      const el = this.shadowRoot.getElementById(`countdown-${entry}`);
      if (el) el.textContent = left ? `The code works for another ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.` : "The pairing window is closing…";
      if (!left) closed = true;
    }
    if (closed && this._ticks % 2 === 0) this._refreshMatter(); // pick up the closed window quickly
  }

  // --- DMX monitor ---------------------------------------------------------------------------

  _startDmxPoll() {
    this._stopDmxPoll();
    this._refreshDmx();
    this._dmxTimer = setInterval(() => this._refreshDmx(), DMX_POLL_MS);
  }

  _stopDmxPoll() {
    clearInterval(this._dmxTimer);
    this._dmxTimer = null;
  }

  async _refreshDmx() {
    if (this._dmxBusy || !this._hass) return; // a slow answer: skip a beat rather than pile up requests
    this._dmxBusy = true;
    const hadTab = this._hasDmx;
    try {
      for (const master of this._data?.masters || []) {
        const prev = this._dmx[master.entry_id];
        let snap;
        try {
          snap = await this._hass.callWS({ type: "netroni/dmx_snapshot", entry_id: master.entry_id });
        } catch (err) {
          snap = { output: false, error: err.message || String(err) };
        }
        snap.at = Date.now();
        if (prev?.output && snap.output && snap.at > prev.at) {
          const fps = ((snap.frames - prev.frames) * 1000) / (snap.at - prev.at);
          snap.fps = prev.fps == null ? fps : prev.fps * 0.7 + fps * 0.3; // smoothed
        }
        this._dmx[master.entry_id] = snap;
      }
    } finally {
      this._dmxBusy = false;
    }
    if (this._tab === "dmx") {
      if (this._dmxSignature() !== this._dmxSig) this._renderMain();
      else this._updateDmx();
    } else if (this._hasDmx !== hadTab) {
      this._renderMain();
    }
  }

  get _hasDmx() {
    return Object.values(this._dmx).some((snap) => snap.output);
  }

  /** The grid's layout: which masters send, their XP-Mini blocks, resolution and fixed slots. */
  _dmxSignature() {
    return JSON.stringify(
      (this._data?.masters || []).map((m) => {
        const snap = this._dmx[m.entry_id] || {};
        return [m.entry_id, snap.output, snap.error, snap.resolution, snap.fixed, (snap.blocks || []).map((b) => [b.dmx_start, b.name])];
      })
    );
  }

  _selectSlot(entry, addr) {
    this._dmxSel = `${entry}|${addr}`;
    this.shadowRoot.querySelectorAll(".dmx-cell.sel").forEach((el) => el.classList.remove("sel"));
    this.shadowRoot.getElementById(`dmx-${entry}-${addr}`)?.classList.add("sel");
    this._updateDmx();
  }

  _dmxValue(value) {
    return this._dmxPct ? `${Math.round((value / 255) * 100)} %` : String(value);
  }

  /** Who sets a slot: a fixed value, an XP-Mini output (and the light on it), or nobody. */
  _slotOwner(master, snap, addr) {
    if (snap.fixed?.[addr] != null) return "Fixed value (--dmx-fixed)";
    const block = (snap.blocks || []).find((b) => addr >= b.dmx_start && addr < b.dmx_start + DMX_BLOCK);
    if (!block) return "Not used";
    const offset = addr - block.dmx_start;
    const bits16 = snap.resolution === 16;
    const output = bits16 ? offset >> 1 : offset;
    if (output >= DMX_BLOCK / 2) return `${esc(block.name)} block · not used at 8-bit`;
    const port = (output >> 1) + 1;
    const side = output % 2 ? "B" : "A";
    const lights = master.lights.filter((l) => l.mini_uid === block.uid);
    const light = lights.find((l) => l.key === `port${port}${side.toLowerCase()}`) || lights.find((l) => l.key === `port${port}t`);
    let text = `${esc(block.name)} · Port ${port}${side}`;
    if (bits16) text += offset % 2 ? " fine" : " coarse";
    const tw = light?.key.endsWith("t");
    if (light && (light.name || tw)) text += ` · ${esc(light.name || light.default_name)}`; // the default name repeats the port
    if (tw) text += ` (${side === "A" ? "warm" : "cool"} white)`;
    return text;
  }

  /** Refresh values, status and the info line in place: the grid stays, so no flicker and the hover is kept. */
  _updateDmx() {
    if (this._tab !== "dmx") return;
    const [selEntry, selAddr] = (this._dmxSel || "").split("|");
    for (const master of this._data?.masters || []) {
      const entry = master.entry_id;
      const snap = this._dmx[entry];
      const cells = this.shadowRoot.getElementById(`dmx-grid-${entry}`)?.children;
      if (!snap?.output || !cells) continue;
      for (let i = 0; i < DMX_SLOTS; i++) {
        const value = snap.slots[i];
        const cell = cells[i];
        if (cell._v === value) continue;
        cell._v = value;
        cell.style.background = value ? `rgba(var(--rgb-primary-color, 3, 169, 244), ${(0.15 + (0.85 * value) / 255).toFixed(3)})` : "";
        cell.classList.toggle("on", value > 0);
      }
      const status = this.shadowRoot.getElementById(`dmx-status-${entry}`);
      if (status) status.innerHTML = this._dmxStatus(snap);
      const info = this.shadowRoot.getElementById(`dmx-info-${entry}`);
      if (info) {
        info.innerHTML =
          selEntry === entry
            ? `<b>Channel ${selAddr}</b> · ${this._dmxValue(snap.slots[selAddr - 1])} · ${this._slotOwner(master, snap, Number(selAddr))}`
            : `<span class="sub">Point at a channel (or tap it) to see its value and what sets it.</span>`;
      }
    }
  }

  _dmxStatus(snap) {
    const rate = snap.fps != null ? `${Math.round(snap.fps)} frames/s` : `${snap.rate} frames/s`;
    const fixed = Object.entries(snap.fixed || {}).map(([a, v]) => `${a} = ${v}`).join(", ");
    return `${this._chip(!snap.errors, "Sending", "Frames failing")}
      ${this._fact("Port", esc(snap.device))}
      ${this._fact("Resolution", `${snap.resolution}-bit`)}
      ${this._fact("Rate", rate)}
      ${this._fact("Fixed", fixed || "none")}`;
  }

  _dmxCard(master) {
    const snap = this._dmx[master.entry_id];
    const unit = snap?.output
      ? `<select class="dmx-unit" data-action="dmx-unit" title="Show values as">
          <option value="raw" ${this._dmxPct ? "" : "selected"}>0–255</option>
          <option value="pct" ${this._dmxPct ? "selected" : ""}>%</option></select>`
      : "";
    const head = `
      <div class="card-head">
        <ha-icon class="head-icon" icon="mdi:knob"></ha-icon>
        <div class="grow"><h2>DMX Output</h2><div class="sub">${esc(master.name)} · Universe 1</div></div>
        ${unit}
      </div>`;
    if (!snap) return `<section class="card">${head}<div class="empty small">Loading…</div></section>`;
    if (!snap.output) {
      const why = snap.error ? esc(snap.error) : "This XP-Master doesn't send DMX itself.";
      return `<section class="card">${head}<div class="sub pad">${why}</div></section>`;
    }
    const entry = master.entry_id;
    const starts = new Map((snap.blocks || []).map((b) => [b.dmx_start, b]));
    let labels = "";
    for (let start = 1; start <= DMX_SLOTS; start += DMX_BLOCK) {
      const block = starts.get(start);
      labels += `<div class="dmx-label">${start}${block ? ` <span>${esc(block.name)}</span>` : ""}</div>`;
    }
    let cells = "";
    for (let addr = 1; addr <= DMX_SLOTS; addr++) {
      const fixed = snap.fixed?.[addr] != null ? " fixed" : "";
      const sel = this._dmxSel === `${entry}|${addr}` ? " sel" : "";
      cells += `<div class="dmx-cell${fixed}${sel}" id="dmx-${entry}-${addr}" data-action="dmx-slot" data-entry="${entry}" data-addr="${addr}"></div>`;
    }
    return `
      <section class="card">
        ${head}
        <div class="facts dmx-status" id="dmx-status-${entry}">${this._dmxStatus(snap)}</div>
        <div class="dmx">
          <div class="dmx-labels">${labels}</div>
          <div class="dmx-grid" id="dmx-grid-${entry}">${cells}</div>
        </div>
        <div class="dmx-info" id="dmx-info-${entry}"></div>
        <div class="dmx-legend sub">
          <span><i class="dmx-cell on" style="background: rgba(var(--rgb-primary-color, 3, 169, 244), .6)"></i>Value: the brighter, the higher</span>
          <span><i class="dmx-cell fixed"></i>Fixed value</span>
          <span><i class="dmx-cell"></i>Zero or not used</span>
        </div>
      </section>`;
  }

  // --- lookups ------------------------------------------------------------------------------

  _master(entry) {
    return this._data?.masters.find((m) => m.entry_id === entry);
  }

  _mini(entry, uid) {
    return this._master(entry)?.minis.find((m) => m.uid === uid);
  }

  _miniName(master, uid) {
    return master?.minis.find((m) => m.uid === uid)?.name || uid;
  }

  // --- rendering ----------------------------------------------------------------------------

  _renderMain() {
    const main = this.shadowRoot.getElementById("main");
    if (!main || !this._hass) return;
    const scroll = this.shadowRoot.querySelector(".content")?.scrollTop;
    main.innerHTML = `
      <div class="toolbar">
        ${this._narrow ? `<button class="icon-btn" data-action="menu" title="Menu"><ha-icon icon="mdi:menu"></ha-icon></button>` : ""}
        <ha-icon class="logo" icon="netroni:logo"></ha-icon>
        <div class="title">Netroni</div>
      </div>
      <div class="tabs">
        ${this._tabButton("installation", "Installation")}
        ${this._tabButton("groups", "Groups")}
        ${this._tabButton("matter", "Matter Connections")}
        ${this._hasDmx || this._tab === "dmx" ? this._tabButton("dmx", "DMX Output") : ""}
      </div>
      <div class="content"><div class="inner">${this._body()}</div></div>`;
    if (scroll) this.shadowRoot.querySelector(".content").scrollTop = scroll;
    if (this._tab === "matter") this._updateCountdowns();
    if (this._focusMini && this._tab === "installation" && this._data) {
      const id = `mini-${this._focusMini}`;
      if (this.shadowRoot.getElementById(id)) {
        this._focused = this._focusMini; // highlighted from now on (the card is drawn with it)
        this._focusMini = null;
        this.shadowRoot.getElementById(id).classList.add("focused");
        // Look the card up again: the panel may have been drawn anew in between.
        setTimeout(() => this.shadowRoot.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
      }
    }
    if (this._tab === "dmx") {
      this._dmxSig = this._dmxSignature();
      this._updateDmx();
    }
  }

  _tabButton(tab, label) {
    return `<button class="tab ${this._tab === tab ? "active" : ""}" data-action="tab" data-tab="${tab}">${label}</button>`;
  }

  _body() {
    if (this._error) return this._banner("error", "mdi:alert-circle-outline", esc(this._error));
    if (!this._data) return `<div class="empty">Loading…</div>`;
    if (!this._data.masters.length) {
      return `<div class="empty">No XP-Master is connected. Add one in Settings → Devices &amp; services.</div>`;
    }
    if (this._tab === "matter") return this._data.masters.map((m) => this._matterCard(m)).join("");
    if (this._tab === "groups") return this._data.masters.map((m) => this._groupsCard(m)).join("");
    if (this._tab === "dmx") return this._data.masters.map((m) => this._dmxCard(m)).join("");
    return this._data.masters.map((m) => this._installation(m)).join("");
  }

  _banner(kind, icon, html, action = "") {
    return `<div class="banner ${kind}"><ha-icon icon="${icon}"></ha-icon><div class="grow">${html}</div>${action}</div>`;
  }

  _chip(ok, yes, no) {
    return `<span class="chip ${ok ? "ok" : "bad"}"><span class="dot"></span>${ok ? yes : no}</span>`;
  }

  _fact(label, value) {
    return `<div class="fact"><div class="fact-label">${label}</div><div class="fact-value">${value}</div></div>`;
  }

  _installation(master) {
    const tw = master.minis.reduce((n, m) => n + m.pairs.length, 0);
    const offline = master.minis.filter((m) => !m.online).length;
    const head = `
      <section class="card">
        <div class="card-head">
          <ha-icon class="head-icon" icon="netroni:logo"></ha-icon>
          <div class="grow">
            <h2>${esc(master.name)}</h2>
            <div class="sub">XP-Master · ${esc(master.master_id)}${master.area ? ` · ${esc(master.area)}` : ""}</div>
          </div>
          ${this._chip(master.connected, "Connected", "Not connected")}
          ${master.device_id ? this._deviceLink(master.device_id) : ""}
        </div>
        <div class="facts">
          ${this._fact("Address", esc(master.host))}
          ${this._fact("XP-Minis", `${master.minis.length}${offline ? ` <span class="warn-text">(${offline} offline)</span>` : ""}`)}
          ${this._fact("Lights", master.lights.length)}
          ${this._fact("Tunable-white ports", tw)}
          ${this._fact("Configuration", master.config_version ? `version ${master.config_version}` : "—")}
        </div>
      </section>`;
    return head + master.minis.map((mini) => this._miniCard(master, mini)).join("");
  }

  _deviceLink(deviceId) {
    return `<button class="icon-btn" data-action="device" data-device="${esc(deviceId)}" title="Open the device page"><ha-icon icon="mdi:open-in-new"></ha-icon></button>`;
  }

  _miniCard(master, mini) {
    const ports = Array.from({ length: master.ports_per_mini }, (_, i) => this._port(master, mini, i + 1)).join("");
    const data = `data-entry="${master.entry_id}" data-uid="${esc(mini.uid)}"`;
    const spares = master.minis.filter((m) => m.online && m.uid !== mini.uid);
    const offline = !mini.online
      ? this._banner(
          "warn",
          "mdi:lan-disconnect",
          `<b>${esc(mini.name)} is offline.</b> It no longer answers so its lights can't be controlled. Check its cable and power supply.`,
          this._admin
            ? (spares.length ? `<button class="btn" data-action="replace" ${data}>Replace…</button> ` : "") +
                `<button class="btn danger" data-action="remove" ${data}>Remove XP-Mini</button>`
            : ""
        )
      : "";
    const gear = this._admin
      ? `<button class="icon-btn" data-action="mini-actions" ${data} title="Restart, factory reset, replace or remove"><ha-icon icon="mdi:cog-outline"></ha-icon></button>`
      : "";
    return `
      <section class="card mini ${mini.online ? "" : "offline"} ${this._focused === mini.uid ? "focused" : ""}" id="mini-${esc(mini.uid)}">
        <div class="card-head">
          <ha-icon class="head-icon mini-icon" icon="netroni:xp-mini"></ha-icon>
          <div class="grow">
            <h3>${esc(mini.name)}</h3>
            <div class="sub">XP-Mini · ${esc(mini.uid)}${mini.hardware_uid && mini.hardware_uid !== mini.uid ? ` (unit ${esc(mini.hardware_uid)})` : ""}${mini.area ? ` · ${esc(mini.area)}` : ""}</div>
          </div>
          ${this._chip(mini.online, "Online", "Offline")}
          ${gear}
          ${mini.device_id ? this._deviceLink(mini.device_id) : ""}
        </div>
        <div class="facts">
          ${this._fact("DMX", `${mini.dmx_start}–${mini.dmx_start + 31}`)}
          ${this._fact("Firmware", esc(mini.firmware || "—"))}
          ${this._fact("Tunable-white ports", mini.pairs.length ? mini.pairs.map((p) => `${p}T`).join(", ") : "none")}
        </div>
        ${offline}
        <div class="ports">${ports}</div>
      </section>`;
  }

  _port(master, mini, port) {
    const lights = master.lights.filter((l) => l.mini_uid === mini.uid && portOf(l) === port).sort((a, b) => a.key.localeCompare(b.key));
    const tw = mini.pairs.includes(port);
    const hl = this._identified.get(`${master.entry_id}|${mini.uid}|${port}`);
    const data = `data-entry="${master.entry_id}" data-uid="${esc(mini.uid)}" data-port="${port}"`;
    return `
      <div class="port ${hl ? "identified" : ""}" id="port-${esc(mini.uid)}-${port}">
        <div class="port-head">
          <span class="port-name">Port ${port}</span>
          ${hl ? `<span class="hl-note">Identified</span>` : ""}
          <button class="icon-btn small" data-action="identify" ${data} ${mini.online ? "" : "disabled"}
            title="Identify: flash Port ${port}A and ${port}B"><ha-icon icon="mdi:flash-outline"></ha-icon></button>
        </div>
        ${lights.map((l) => this._light(master, l, hl)).join("")}
        <div class="tw-row">
          <label class="tw ${this._admin ? "" : "readonly"}" title="${this._admin ? "One light: A warm white, B cool white" : "Only an administrator can change this"}">
            <input type="checkbox" data-action="tw" ${data} ${tw ? "checked" : ""} ${this._admin ? "" : "disabled"}>
            <span class="switch"></span>Tunable white
          </label>
          ${tw ? this._rangeChip(master, mini, port, data) : ""}
        </div>
      </div>`;
  }

  _cctRange(master, mini, port) {
    const light = master.lights.find((l) => l.mini_uid === mini.uid && l.key === `port${port}t`);
    return light?.min_kelvin && light?.max_kelvin ? [light.min_kelvin, light.max_kelvin] : CCT_DEFAULT;
  }

  _rangeChip(master, mini, port, data) {
    const range = this._cctRange(master, mini, port);
    const custom = range[0] !== CCT_DEFAULT[0] || range[1] !== CCT_DEFAULT[1];
    const label = cctLabel(range);
    return this._admin
      ? `<button class="range ${custom ? "custom" : ""}" data-action="cct" ${data} title="Colour range of the strip on Port ${port}">${label}</button>`
      : `<span class="range ${custom ? "custom" : ""}" title="Colour range of the strip on Port ${port}">${label}</span>`;
  }

  _light(master, light, hl) {
    const st = this._hass.states[light.entity_id];
    const unavailable = !st || st.state === "unavailable";
    const on = st?.state === "on";
    let state = unavailable ? "Unavailable" : on ? "On" : "Off";
    if (on && st.attributes.brightness) state = `${Math.round(st.attributes.brightness / 2.55)} %`;
    if (on && light.kind === "tunable_white" && st.attributes.color_temp_kelvin) state += ` · ${st.attributes.color_temp_kelvin} K`;
    const marked = hl && hl.lightIds.includes(light.id);
    const icon = light.kind === "tunable_white" ? "mdi:lightbulb-on-outline" : "mdi:lightbulb-outline";
    const edit = this._admin
      ? `<button class="icon-btn small" data-action="edit" data-entry="${master.entry_id}" data-light="${esc(light.id)}" title="Name and area"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>`
      : "";
    return `
      <div class="light ${on ? "on" : ""} ${unavailable ? "unavailable" : ""} ${marked ? "marked" : ""}">
        <button class="lamp" data-action="toggle" data-entity="${esc(light.entity_id)}" ${unavailable ? "disabled" : ""}
          title="${on ? "Turn off" : "Turn on"}"><ha-icon icon="${icon}"></ha-icon></button>
        <div class="light-text" data-action="more-info" data-entity="${esc(light.entity_id)}" title="Brightness and colour">
          <div class="light-name ${light.name ? "" : "unnamed"}">${esc(light.name || light.default_name)}</div>
          <div class="light-sub">${tagOf(light)} · ${esc(light.area || "No area")} · ${state}</div>
          ${this._groupChip(master, light)}
        </div>
        ${edit}
      </div>`;
  }

  /** Under a light that is in a group: the group's name; a click opens it in the Groups tab. */
  _groupChip(master, light) {
    const group = light.group && (master.groups || []).find((g) => g.id === light.group);
    if (!group) return "";
    return `<button class="group-chip" data-action="goto-group" data-entry="${master.entry_id}" data-group="${esc(group.id)}"
      title="In the group ${esc(group.name)}: open it"><ha-icon icon="mdi:lightbulb-group-outline"></ha-icon>${esc(group.name)}</button>`;
  }

  _groupsCard(master) {
    const groups = master.groups || [];
    const intro = groups.length
      ? ""
      : `<section class="card"><div class="card-head"><ha-icon class="head-icon" icon="mdi:lightbulb-group-outline"></ha-icon>
          <div class="grow"><h2>Groups</h2><div class="sub">${esc(master.name)} · Lights dimmed together: each keeps its own level, the group dims them all.</div></div></div>
          <div class="sub pad">No groups yet.</div></section>`;
    const add = this._admin
      ? `<div class="actions"><button class="btn" data-action="new-group" data-entry="${master.entry_id}">New group</button></div>`
      : "";
    return intro + groups.map((g) => this._groupCard(master, g)).join("") + add;
  }

  _groupCard(master, group) {
    const gst = this._hass.states[group.entity_id];
    const fader = Number(gst?.attributes.brightness ?? 255);
    const on = gst?.state === "on";
    const members = group.members.map((id) => master.lights.find((l) => l.id === id)).filter(Boolean);
    const minis = new Set(members.map((l) => l.mini_uid)).size;
    const pct = (v) => `${Math.round((v / 255) * 100)} %`;
    const rows = members
      .map((light) => {
        const st = this._hass.states[light.entity_id];
        const unavailable = !st || st.state === "unavailable";
        const lit = st?.state === "on";
        const own = Number(st?.attributes.brightness ?? 0) || 0;
        const out = lit ? Math.round((own * fader) / 255) : 0;
        const mini = this._miniName(master, light.mini_uid);
        return `
          <div class="grow-row ${lit ? "on" : ""}">
            <button class="lamp" data-action="toggle" data-entity="${esc(light.entity_id)}" ${unavailable ? "disabled" : ""}><ha-icon icon="mdi:lightbulb-outline"></ha-icon></button>
            <div class="gr-name"><div class="light-name">${esc(light.name || light.default_name)}</div><div class="light-sub">${esc(mini)} · ${light.key.replace("port", "").toUpperCase()}</div></div>
            <input class="slider own" type="range" min="1" max="255" value="${own || 255}" data-action="dim" data-entity="${esc(light.entity_id)}" ${unavailable ? "disabled" : ""}>
            <div class="gr-pct">${unavailable ? "Unavailable" : lit ? `own ${pct(own)} → <b>${pct(out)}</b>` : "Off"}</div>
          </div>`;
      })
      .join("");
    const edit = this._admin
      ? `<button class="btn secondary" data-action="edit-group" data-entry="${master.entry_id}" data-group="${esc(group.id)}">Edit</button>`
      : "";
    const target = this._gotoGroup === `${master.entry_id}|${group.id}` ? "target" : "";
    return `
      <section class="card group-card ${target}" id="group-${master.entry_id}-${esc(group.id)}">
        <div class="card-head">
          <ha-icon class="head-icon group-icon" icon="mdi:lightbulb-group-outline"></ha-icon>
          <div class="grow"><h3>${esc(group.name)}</h3>
            <div class="sub">Group · ${members.length} light${members.length === 1 ? "" : "s"}${minis > 1 ? ` on ${minis} XP-Minis` : ""} · ${esc(group.area || "No area")}</div></div>
          ${edit}
        </div>
        <div class="grow-row group-fader ${on ? "on" : ""}">
          <button class="lamp" data-action="toggle" data-entity="${esc(group.entity_id)}" ${gst ? "" : "disabled"}><ha-icon icon="mdi:lightbulb-group-outline"></ha-icon></button>
          <div class="gr-name"><div class="light-name"><b>Group</b></div><div class="light-sub">dims all members together</div></div>
          <input class="slider" type="range" min="1" max="255" value="${fader}" data-action="dim" data-entity="${esc(group.entity_id)}" ${gst ? "" : "disabled"}>
          <div class="gr-pct"><b>${on ? pct(fader) : "Off"}</b></div>
        </div>
        ${rows || `<div class="sub pad">No lights in this group. ${this._admin ? "Use Edit to add some." : ""}</div>`}
      </section>`;
  }

  _matterCard(master) {
    const status = this._matter[master.entry_id];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.error) body = this._banner("error", "mdi:alert-circle-outline", esc(status.error));
    else if (!status.connected && status.starting) body = this._banner("info", "mdi:timer-sand", "The Matter bridge of the XP-Master is starting. This takes about a minute.");
    else if (!status.connected) body = this._banner("warn", "mdi:power-plug-off-outline", "The Matter bridge of the XP-Master is not running.");
    else body = this._matterBody(master, status);
    return `
      <section class="card">
        <div class="card-head">
          <ha-icon class="head-icon" icon="mdi:access-point-network"></ha-icon>
          <div class="grow">
            <h2>Matter Connections</h2>
            <div class="sub">${esc(master.name)} · SmartThings, Google Home, Alexa and Apple Home control the lights through Matter.</div>
          </div>
        </div>
        ${body}
      </section>`;
  }

  _matterBody(master, status) {
    const apps = (status.fabrics || []).map(
      (f) => `<div class="app"><ha-icon icon="${APP_ICONS[f.vendor] || "mdi:cellphone-link"}"></ha-icon>
        <div class="grow"><div>${esc(f.label || f.vendor)}</div><div class="sub">${esc(f.vendor)}</div></div></div>`
    );
    const paired = status.commissioned && apps.length;
    let html = `<h4>Paired apps</h4>${paired ? `<div class="apps">${apps.join("")}</div>` : `<div class="sub pad">Not paired with any app yet.</div>`}`;

    if (status.qr) {
      const until = `<div class="sub" id="countdown-${master.entry_id}">The code works for 3 minutes.</div>`;
      const cancel = this._admin
        ? `<div class="actions"><button class="btn secondary" data-action="cancel-pairing" data-entry="${master.entry_id}" ${status.closing ? "disabled" : ""}>${status.closing ? "Cancelling…" : "Cancel"}</button></div>`
        : "";
      html += `
        <div class="qr-box">
          <img class="qr" src="${status.qr}" alt="Matter pairing QR code">
          <div class="grow">
            <h4>${paired ? "Pair another app" : "Pair an app"}</h4>
            <p>In SmartThings, Google Home, Alexa or Apple Home, choose to add a Matter device and scan this code.</p>
            <p>Or enter the setup code <b class="code">${esc(status.code || status.manual_code)}</b></p>
            ${until}
            <p class="sub">Every XP-Mini light appears as its own device, named as in Home Assistant.</p>
            ${cancel}
          </div>
        </div>`;
    } else if (this._admin) {
      html += `<div class="actions"><button class="btn" data-action="pair-app" data-entry="${master.entry_id}" ${status.opening ? "disabled" : ""}>
        ${status.opening ? "Opening…" : paired ? "Pair another app" : "Pair an app"}</button></div>`;
    } else {
      html += `<div class="sub pad">An administrator can pair ${paired ? "another" : "an"} app.</div>`;
    }
    return html;
  }

  // --- dialogs ------------------------------------------------------------------------------

  _openDialog(dialog) {
    this._dialog = dialog;
    this._busy = false;
    this._renderDialog();
  }

  _cctLabels(warm, cool) {
    return `<span>${warm} K · A 100 %</span><span>${Math.round((warm + cool) / 2)} K · 50 / 50</span><span>${cool} K · B 100 %</span>`;
  }

  _closeDialog() {
    this._dialog = null;
    this._renderDialog();
  }

  _renderDialog() {
    const host = this.shadowRoot.getElementById("dialog");
    const d = this._dialog;
    if (!d) {
      host.innerHTML = "";
      return;
    }
    // Keep what was typed when the dialog re-renders (busy state).
    const typedName = this.shadowRoot.getElementById("light-name")?.value;
    const typedArea = this.shadowRoot.getElementById("light-area")?.value;
    let title = "";
    let body = "";
    let action = "";
    if (d.kind === "edit") {
      const master = this._master(d.entry);
      title = d.identified ? `${esc(d.light.default_name)} identified itself` : `Name ${esc(d.light.default_name)}`;
      const areas = Object.values(this._hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name));
      const current = typedArea ?? d.light.area_id ?? "";
      body = `
        <p class="sub">${esc(this._miniName(master, d.light.mini_uid))} · ${esc(d.light.default_name)}</p>
        <label class="field"><span>Name</span>
          <input id="light-name" type="text" value="${esc(typedName ?? d.light.name ?? "")}" placeholder="${esc(d.light.default_name)}" ${this._busy ? "disabled" : ""}></label>
        <label class="field"><span>Area</span>
          <select id="light-area" ${this._busy ? "disabled" : ""}>
            <option value="">No area</option>
            ${areas.map((a) => `<option value="${esc(a.area_id)}" ${a.area_id === current ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          </select></label>`;
      action = `<button class="btn" data-action="save-light" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "group") {
      const master = this._master(d.entry);
      const typed = this.shadowRoot.getElementById("group-name")?.value;
      title = d.groupId ? `Edit ${esc(d.name)}` : "New group";
      const byMini = master.minis
        .map((mini) => {
          const items = master.lights
            .filter((l) => l.mini_uid === mini.uid)
            .map((l) => {
              // A light in another group can't be picked here: remove it from that group first.
              const other = l.group && l.group !== d.groupId ? master.groups.find((g) => g.id === l.group) : null;
              const checked = d.members.includes(l.id) ? "checked" : "";
              const locked = other || this._busy ? "disabled" : "";
              return `<label class="member ${other ? "taken" : ""}" ${other ? `title="In ${esc(other.name)}: remove it there first"` : ""}>
                <input type="checkbox" data-action="member" data-light="${esc(l.id)}" ${checked} ${locked}>
                <span>${esc(l.name || l.default_name)}</span><span class="sub">${esc(mini.name)} · ${l.key.replace("port", "").toUpperCase()}${other ? ` · in ${esc(other.name)}` : ""}</span></label>`;
            })
            .join("");
          return `<div class="member-mini">${esc(mini.name)}</div>${items}`;
        })
        .join("");
      body = `
        <label class="field"><span>Name</span>
          <input id="group-name" type="text" value="${esc(typed ?? d.name)}" placeholder="Kitchen ceiling" ${this._busy ? "disabled" : ""}></label>
        <div class="members-block"><div class="members-label">Lights</div><div class="members">${byMini}</div></div>
        <label class="field"><span>Area${d.areaTouched ? "" : " (the lights' area, if they share one)"}</span>
          <select id="group-area" ${this._busy ? "disabled" : ""}>
            <option value="">No area</option>
            ${Object.values(this._hass.areas || {}).sort((a, b) => a.name.localeCompare(b.name))
              .map((a) => `<option value="${esc(a.area_id)}" ${a.area_id === d.areaId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          </select></label>
        <label class="tw hide-row"><input type="checkbox" id="group-hide" ${d.hideMembers !== false ? "checked" : ""} ${this._busy ? "disabled" : ""}>
          <span class="switch"></span>Show only the group in Home Assistant and Matter apps</label>
        <p class="sub hide-note">Its lights are hidden on the Home Assistant dashboards (still usable in automations) and left out of SmartThings, Google Home and other Matter apps.</p>
        <p class="sub">A light is in one group at most: to move one here, remove it from its group first. Dimming the group keeps the lights' own levels relative to each other.</p>`;
      action = `${d.groupId ? `<button class="btn ${d.confirmDelete ? "danger" : "secondary"}" data-action="delete-group" ${this._busy ? "disabled" : ""}>${d.confirmDelete ? "Delete for good" : "Delete group"}</button>` : ""}
        <button class="btn" data-action="save-group" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "cct") {
      const mini = this._mini(d.entry, d.uid);
      const light = this._master(d.entry)?.lights.find((l) => l.mini_uid === d.uid && l.key === `port${d.port}t`);
      const preset = CCT_PRESETS.findIndex((p) => p.range[0] === d.warm && p.range[1] === d.cool);
      const selected = d.custom ? -1 : preset;
      const locked = selected >= 0 || this._busy ? "disabled" : "";
      title = `Colour range of Port ${d.port}T`;
      body = `
        <p class="sub">${esc(mini?.name)} · ${esc(light?.name || light?.default_name || `Port ${d.port}T`)} · the strip's warmest and coolest white</p>
        <label class="field"><span>Strip</span>
          <select id="cct-preset" ${this._busy ? "disabled" : ""}>
            ${CCT_PRESETS.map((p, i) => `<option value="${i}" ${i === selected ? "selected" : ""}>${p.label} · ${cctLabel(p.range)}</option>`).join("")}
            <option value="custom" ${selected < 0 ? "selected" : ""}>Custom</option>
          </select></label>
        <div class="field-row">
          <label class="field"><span>Warm (A at 100 %), K</span>
            <input id="cct-warm" type="number" min="1000" max="10000" step="50" value="${d.warm}" ${locked}></label>
          <label class="field"><span>Cool (B at 100 %), K</span>
            <input id="cct-cool" type="number" min="1000" max="10000" step="50" value="${d.cool}" ${locked}></label>
        </div>
        <div class="cct-bar"></div>
        <div class="cct-labels" id="cct-labels">${this._cctLabels(d.warm, d.cool)}</div>
        <p class="sub">Home Assistant, Matter and the XP-Mini use this range for this light. A colour temperature outside the new range moves to its nearest end.</p>`;
      action = `<button class="btn" data-action="save-cct" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "pairs") {
      const mini = this._mini(d.entry, d.uid);
      title = d.make ? `Make Port ${d.port} tunable white?` : `Split Port ${d.port}T?`;
      body = d.make
        ? `<p>Port ${d.port}A and Port ${d.port}B of ${esc(mini?.name)} become one light, <b>Port ${d.port}T</b>, with brightness and colour temperature: A is warm white, B cool white.</p>`
        : `<p><b>Port ${d.port}T</b> of ${esc(mini?.name)} becomes two dimmable lights again, Port ${d.port}A and Port ${d.port}B.</p>`;
      body += `<p class="sub">The lights that are replaced lose their names and areas; automations, scenes and dashboards that use them must be updated.</p>`;
      action = `<button class="btn" data-action="confirm-pairs" ${this._busy ? "disabled" : ""}>${d.make ? "Make tunable white" : "Split"}</button>`;
    } else if (d.kind === "remove") {
      const mini = this._mini(d.entry, d.uid);
      title = `Remove ${esc(mini?.name || d.uid)}?`;
      body = `<p>${esc(mini?.name || d.uid)} (${esc(d.uid)}) is removed from the XP-Master: its lights, names and DMX block are deleted.</p>
        <p class="sub">If it is connected again later, it will be added as a new XP-Mini.</p>`;
      action = `<button class="btn danger" data-action="confirm-remove" ${this._busy ? "disabled" : ""}>Remove XP-Mini</button>`;
    } else if (d.kind === "mini-actions") {
      const master = this._master(d.entry);
      const mini = this._mini(d.entry, d.uid);
      const data = `data-entry="${d.entry}" data-uid="${esc(d.uid)}"`;
      const spares = (master?.minis || []).some((m) => m.online && m.uid !== d.uid);
      const item = (action, icon, label, text, enabled, danger = false) => `
        <button class="menu-item ${danger ? "danger-text" : ""}" data-action="${action}" ${data} ${enabled ? "" : "disabled"}>
          <ha-icon icon="${icon}"></ha-icon><span><b>${label}</b><span class="sub">${text}</span></span></button>`;
      title = esc(mini?.name || d.uid);
      body = `<div class="menu">
        ${item("restart", "mdi:restart", "Restart", "Keeps all its settings; back within a few seconds.", mini?.online)}
        ${item("reset", "mdi:backup-restore", "Factory reset…", "Forgets everything; found again as a new XP-Mini.", mini?.online, true)}
        ${item("replace", "mdi:swap-horizontal", "Replace…", mini?.online ? "Only when it is offline: a new XP-Mini takes its place." : "A new XP-Mini takes its place.", !mini?.online && spares)}
        ${item("remove", "mdi:delete-outline", "Remove…", mini?.online ? "Only when it is offline (disconnected for good)." : "Forget it: lights, names and DMX block.", !mini?.online, true)}
      </div>`;
    } else if (d.kind === "reset") {
      const mini = this._mini(d.entry, d.uid);
      const name = esc(mini?.name || d.uid);
      title = `Reset ${name} to factory settings?`;
      body = `<p>${name} (${esc(d.uid)}) forgets all its settings and its lights go off. The XP-Master forgets it too: it is found again at once as a new XP-Mini, with default light names, no areas and the first free DMX block.</p>
        <p class="sub">Automations, scenes and dashboards that use its lights may have to be updated. To restart it without losing anything, use Restart instead.</p>`;
      action = `<button class="btn danger" data-action="confirm-reset" ${this._busy ? "disabled" : ""}>Factory reset</button>`;
    } else if (d.kind === "replace") {
      const master = this._master(d.entry);
      const mini = this._mini(d.entry, d.uid);
      const name = esc(mini?.name || d.uid);
      const spares = (master?.minis || []).filter((m) => m.online && m.uid !== d.uid).sort((a, b) => b.replace_candidate - a.replace_candidate);
      title = `Replace ${name}`;
      body = `<p>The new XP-Mini takes the place of ${name}: its DMX block ${mini?.dmx_start}, port settings, light names, areas and groups. The lights keep their entities, so automations, scenes, dashboards and Matter apps keep working.</p>
        <label class="field"><span>New XP-Mini</span>
          <select id="replace-new">${spares
            .map((m) => `<option value="${esc(m.uid)}">${esc(m.name)} (${esc(m.hardware_uid || m.uid)})${m.replace_candidate ? " · new" : ""}</option>`)
            .join("")}</select></label>
        <p class="sub">The new XP-Mini's own entry is removed, with any names given to its lights.</p>`;
      action = `<button class="btn" data-action="confirm-replace" ${this._busy ? "disabled" : ""}>Replace</button>`;
    }
    host.innerHTML = `
      <div class="scrim" data-action="scrim">
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-head"><h2>${title}</h2>
            <button class="icon-btn" data-action="close-dialog" title="Close"><ha-icon icon="mdi:close"></ha-icon></button></div>
          ${body}
          <div class="dialog-actions">
            <button class="btn secondary" data-action="close-dialog">${action ? "Cancel" : "Close"}</button>${action}
          </div>
        </div>
      </div>`;
  }
}

const STYLE = `
  :host {
    display: block; height: 100%; background: var(--primary-background-color); color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    --ok: var(--success-color, #43a047); --bad: var(--error-color, #db4437); --warn: var(--warning-color, #ffa600);
    --card: var(--ha-card-background, var(--card-background-color, #fff)); --line: var(--divider-color, rgba(0,0,0,.12));
    --lamp-on: var(--state-light-active-color, #ff9800);
    --mdc-icon-size: 20px;
  }
  * { box-sizing: border-box; }
  #main { display: flex; flex-direction: column; height: 100%; }
  .toolbar { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 16px; flex: none;
    background: var(--app-header-background-color, var(--card)); color: var(--app-header-text-color, var(--primary-text-color));
    border-bottom: 1px solid var(--line); }
  .toolbar .title { font-size: 20px; font-weight: 400; }
  .logo { --mdc-icon-size: 24px; }
  .tabs { display: flex; gap: 4px; padding: 0 16px; flex: none; background: var(--card); border-bottom: 1px solid var(--line); overflow-x: auto; }
  .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--secondary-text-color);
    font: inherit; font-weight: 500; padding: 14px 12px 12px; cursor: pointer; white-space: nowrap; }
  .tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .content { flex: 1; overflow-y: auto; }
  .inner { max-width: 1240px; margin: 0 auto; padding: 16px; }
  .empty { padding: 48px 16px; text-align: center; color: var(--secondary-text-color); }
  .empty.small { padding: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--ha-card-border-radius, 12px);
    padding: 16px; margin-bottom: 16px; box-shadow: var(--ha-card-box-shadow, none); }
  .card.offline { border-color: var(--warn); }
  .card-head { display: flex; align-items: center; gap: 12px; }
  .head-icon { --mdc-icon-size: 28px; color: var(--primary-color); flex: none; }
  .head-icon.mini-icon { --mdc-icon-size: 40px; margin: -6px -4px; } /* tall drawing: larger box */
  .grow { flex: 1; min-width: 0; }
  h2, h3, h4 { margin: 0; font-weight: 500; }
  h2 { font-size: 20px; } h3 { font-size: 17px; } h4 { font-size: 14px; margin: 16px 0 8px; }
  .sub { color: var(--secondary-text-color); font-size: 13px; }
  .sub.pad { padding: 4px 0 8px; }
  p { margin: 8px 0; line-height: 1.45; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px;
    font-weight: 500; white-space: nowrap; border: 1px solid currentColor; }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .chip.ok { color: var(--ok); } .chip.bad { color: var(--bad); }
  .warn-text { color: var(--warn); }
  .facts { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 14px 0 2px; }
  .fact-label { font-size: 12px; color: var(--secondary-text-color); }
  .fact-value { font-size: 14px; margin-top: 2px; }
  .banner { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 14px; border-radius: 10px; line-height: 1.4; }
  .banner.warn { background: rgba(255, 166, 0, .14); }
  .banner.warn > ha-icon { color: var(--warn); }
  .banner.info { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
  .banner.info > ha-icon { color: var(--primary-color); }
  .banner.error { background: rgba(219, 68, 55, .12); }
  .banner.error > ha-icon { color: var(--bad); }
  .ports { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; margin-top: 16px; }
  .port { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 4px;
    transition: border-color .3s, box-shadow .3s; }
  .port.identified { border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(var(--rgb-primary-color, 3, 169, 244), .3);
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(var(--rgb-primary-color, 3, 169, 244), .12); } }
  .port-head { display: flex; align-items: center; gap: 8px; min-height: 32px; }
  .port-name { font-weight: 500; flex: 1; }
  .hl-note { font-size: 11px; font-weight: 500; color: var(--text-primary-color, #fff); background: var(--primary-color);
    padding: 2px 8px; border-radius: 999px; }
  .light { display: flex; align-items: center; gap: 6px; border-radius: 8px; padding: 2px 0; }
  .light.marked { background: rgba(var(--rgb-primary-color, 3, 169, 244), .14); }
  .lamp { flex: none; width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center;
    background: rgba(127, 127, 127, .12); color: var(--secondary-text-color); }
  .light.on .lamp { color: var(--lamp-on); background: rgba(255, 152, 0, .16); }
  .light.unavailable .lamp { opacity: .45; cursor: default; }
  .light-text { flex: 1; min-width: 0; cursor: pointer; }
  .light-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .light-name.unnamed { color: var(--secondary-text-color); font-style: italic; }
  .light-sub { font-size: 12px; color: var(--secondary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tw { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text-color); margin-top: 4px; cursor: pointer; user-select: none; }
  .tw.readonly { cursor: default; }
  .tw-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
  .tw-row .tw { margin-top: 0; }
  .range { margin-left: auto; font: inherit; font-size: 12px; white-space: nowrap; padding: 2px 8px; border-radius: 999px; cursor: pointer;
    color: var(--primary-color); background: rgba(var(--rgb-primary-color, 3, 169, 244), .1); border: 1px solid rgba(var(--rgb-primary-color, 3, 169, 244), .35); }
  span.range { cursor: default; }
  .range.custom { color: #e65100; background: rgba(255, 152, 0, .12); border-color: rgba(255, 152, 0, .45); }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  .field input:disabled { opacity: .7; }
  .grow-row { display: grid; grid-template-columns: 34px minmax(120px, 200px) 1fr 140px; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
  .grow-row.group-fader { border-top: 0; margin-top: 8px; }
  .grow-row.on .lamp { color: var(--lamp-on); background: rgba(255, 152, 0, .16); }
  .gr-name { min-width: 0; }
  .gr-pct { font-size: 13px; text-align: right; color: var(--secondary-text-color); }
  .gr-pct b { color: var(--primary-text-color); font-weight: 500; }
  .slider { width: 100%; accent-color: var(--primary-color); }
  .slider.own { accent-color: rgba(var(--rgb-primary-color, 3, 169, 244), .55); }
  .members { max-height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px 4px; }
  .member-mini { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); margin: 0 -10px; padding: 6px 10px 3px;
    position: sticky; top: 0; z-index: 1; background: var(--card); border-bottom: 1px solid var(--line); }
  .members-block { margin-top: 14px; }
  .members-label { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px; }
  .member { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 14px; cursor: pointer; }
  .member input { width: auto; margin: 0; flex: none; }
  .group-chip { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; max-width: 100%; font: inherit; font-size: 11px;
    padding: 1px 8px 1px 5px; border-radius: 999px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: #00796b; background: rgba(0, 150, 136, .1); border: 1px solid rgba(0, 150, 136, .4); --mdc-icon-size: 13px; }
  .group-chip:hover { background: rgba(0, 150, 136, .18); }
  .group-icon { color: #00897b; }
  .group-card { transition: box-shadow .4s, border-color .4s; }
  .group-card.target { border-color: #00897b; box-shadow: 0 0 0 3px rgba(0, 150, 136, .25); }
  .hide-row { margin-top: 16px; color: var(--primary-text-color); font-size: 14px; }
  .hide-note { margin-top: 4px; }
  .member.taken { cursor: default; color: var(--disabled-text-color, #9e9e9e); }
  .member .sub { margin-left: auto; font-size: 12px; }
  @media (max-width: 600px) { .grow-row { grid-template-columns: 34px 1fr 90px; } .grow-row .slider { grid-column: 1 / -1; } }
  .cct-bar { height: 14px; border-radius: 7px; margin-top: 16px; border: 1px solid var(--line);
    background: linear-gradient(90deg, #ffb35c, #ffe1b8 50%, #eaf3ff); }
  .cct-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--secondary-text-color); margin-top: 3px; }
  .tw input { position: absolute; opacity: 0; pointer-events: none; }
  .switch { position: relative; width: 32px; height: 18px; border-radius: 9px; background: rgba(127, 127, 127, .4); flex: none; transition: background .2s; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .2s; }
  .tw input:checked + .switch { background: var(--primary-color); }
  .tw input:checked + .switch::after { transform: translateX(14px); }
  .tw input:disabled + .switch { opacity: .6; }
  .tw input:focus-visible + .switch { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .icon-btn { flex: none; width: 40px; height: 40px; border-radius: 50%; border: 0; background: none; color: var(--secondary-text-color);
    cursor: pointer; display: grid; place-items: center; }
  .icon-btn.small { width: 32px; height: 32px; }
  .icon-btn:hover:not(:disabled), .lamp:hover:not(:disabled) { background: rgba(127, 127, 127, .24); }
  .light.on .lamp:hover:not(:disabled) { background: rgba(255, 152, 0, .28); }
  .icon-btn:disabled { opacity: .35; cursor: default; }
  .toolbar .icon-btn { color: inherit; }
  .btn { font: inherit; font-weight: 500; border: 0; border-radius: 20px; padding: 9px 18px; cursor: pointer; white-space: nowrap;
    background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn.secondary { background: none; color: var(--primary-color); }
  .btn.danger { background: var(--bad); color: #fff; }
  .menu { display: flex; flex-direction: column; margin: 4px -12px 0; }
  .menu-item { display: flex; align-items: flex-start; gap: 14px; text-align: left; font: inherit; color: inherit; background: none;
    border: 0; border-radius: 10px; padding: 10px 12px; cursor: pointer; }
  .menu-item:hover:not(:disabled) { background: rgba(127, 127, 127, .14); }
  .menu-item:disabled { opacity: .4; cursor: default; }
  .menu-item > ha-icon { margin-top: 2px; color: var(--secondary-text-color); }
  .menu-item.danger-text, .menu-item.danger-text > ha-icon { color: var(--bad); }
  .menu-item .sub { display: block; font-weight: 400; }
  .card.mini.focused { box-shadow: 0 0 0 2px var(--primary-color); }
  .btn:disabled { opacity: .5; cursor: default; }
  .actions { margin-top: 12px; }
  .apps { display: flex; flex-direction: column; gap: 4px; }
  .app { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .app:last-child { border-bottom: 0; }
  .app ha-icon { color: var(--primary-color); }
  .qr-box { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
  .qr { width: 180px; height: 180px; image-rendering: pixelated; border-radius: 8px; background: #fff; flex: none; }
  .qr-box h4 { margin-top: 0; }
  .code { font-size: 18px; letter-spacing: .5px; }
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: grid; place-items: center; z-index: 10; padding: 16px; }
  .dialog { background: var(--card); color: var(--primary-text-color); border-radius: 16px; padding: 20px 24px; width: 100%; max-width: 460px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, .3); max-height: calc(100% - 32px); overflow-y: auto; }
  .dialog-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .dialog-head h2 { flex: 1; font-size: 18px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .field { display: block; margin-top: 14px; }
  .field span { display: block; font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px; }
  .field input, .field select { width: 100%; font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--primary-background-color); color: var(--primary-text-color); }
  .field input:focus, .field select:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
  .dmx-unit { font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--card); color: var(--primary-text-color); }
  .dmx-status { align-items: center; }
  .dmx { --dmx-row: 18px; display: flex; gap: 8px; margin-top: 16px; }
  .dmx-labels { display: grid; grid-auto-rows: var(--dmx-row); row-gap: 2px; flex: none; width: 128px; }
  .dmx-label { font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden;
    display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .dmx-label span { color: var(--primary-text-color); overflow: hidden; text-overflow: ellipsis; }
  .dmx-grid { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(32, 1fr); grid-auto-rows: var(--dmx-row); gap: 2px; }
  .dmx-cell { border: 1px solid var(--line); border-radius: 3px; cursor: pointer; min-width: 0; }
  .dmx-cell.on { border-color: transparent; }
  .dmx-cell.fixed { box-shadow: inset 0 0 0 2px var(--warn); }
  .dmx-cell.sel { outline: 2px solid var(--primary-text-color); outline-offset: -1px; }
  .dmx-info { margin-top: 12px; min-height: 20px; font-size: 14px; }
  .dmx-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; }
  .dmx-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dmx-legend .dmx-cell { display: inline-block; width: 12px; height: 12px; cursor: default; }
  @media (max-width: 600px) {
    .inner { padding: 12px; }
    .dmx-labels { width: 32px; grid-auto-rows: calc(2 * var(--dmx-row) + 2px); } /* a block takes two lines of 16 */
    .dmx-label span { display: none; }
    .dmx-grid { grid-template-columns: repeat(16, 1fr); }
    .ports { grid-template-columns: 1fr 1fr; }
    .facts { gap: 8px 20px; }
  }
  @media (max-width: 420px) { .ports { grid-template-columns: 1fr; } }
`;

// A page that loaded an older version keeps that one until it is reloaded.
if (!customElements.get("netroni-panel")) customElements.define("netroni-panel", NetroniPanel);
