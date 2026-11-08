// Netroni sidebar panel: installation overview, groups, commissioning and the DMX monitor.
//
// A plain web component (no build step). Home Assistant sets `hass` and `narrow`; the structure
// comes from the integration's "netroni/subscribe" WebSocket subscription and live light states
// from hass.states. Everyone can look and use Identify; changes need an administrator (the
// WebSocket commands enforce it, the panel only hides the controls).

// The Netroni icons (logo, XP-Mini). Also loaded on every page by the integration, for the sidebar;
// imported here too, so the panel has them even when the browser still runs a start page cached
// from before the integration was installed.
import "./netroni-icons.js";

const HIGHLIGHT_MS = 60_000; // how long a port that identified itself stays highlighted
const MATTER_POLL_S = 10;
const ARTNET_POLL_S = 3; // the Settings tab: what Art-Net, sACN and MQTT are doing
const UNIVERSES = { artnet: [0, 32767], sacn: [1, 63999] };
/** The other protocol has the universe: one source at a time across Art-Net and sACN. */
const heldBy = (held, waiting) =>
  `${held.protocol === "sacn" ? "sACN" : "Art-Net"} from <b>${esc(held.source)}</b> has the universe; ${waiting} waits until it stops.`;
const DMX_POLL_MS = 250;
const DMX_SLOTS = 512;
const DMX_ROW = 16; // channels per line of the DMX monitor: an 8-bit block, or half a 16-bit one
// An XP-Mini's DMX block: 16 channels at 8-bit (one per output), 32 at 16-bit (coarse, fine).
const dmxSize = (resolution) => (resolution === 16 ? 32 : 16);
const dmxRange = (start, resolution) => `${start}–${start + dmxSize(resolution) - 1}`;

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
/** A colour temperature as a colour (the approximation Home Assistant's own slider uses). */
const kelvinRgb = (kelvin) => {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return `rgb(${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(", ")})`;
};

// On, and on and off in turn, of a group or a port: a level is optional.
const ACTION_LEVEL_KINDS = ["group_on", "group_toggle", "port_on", "port_toggle"];

const CCT_PRESETS = [
  { label: "Visiolite strip", range: CCT_DEFAULT },
  { label: "Warm to daylight", range: [2700, 6500] },
  { label: "Warm to cool", range: [3000, 6000] },
];
const cctLabel = ([warm, cool]) => `${warm}–${cool} K`;

// Closed cards on the Installation tab, remembered in this browser only ("master:<id>", "mini:<id>/<uid>");
// and the Settings tab's sections that are open ("open:<entry>/<section>": they start closed).
const COLLAPSED_KEY = "netroni-collapsed";
const loadCollapsed = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch (_err) {
    return new Set();
  }
};

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
    this._remote = {}; // entry_id -> status from netroni/remote_status (this XP-Master's remote access)
    this._remoteClosesAt = {}; // entry_id -> ms, when its remote access pairing window closes
    this._windowClosesAt = {}; // entry_id -> ms, when the open pairing window closes (from the bridge)
    this._dmx = {}; // entry_id -> netroni/dmx_snapshot result (plus fps, measured here)
    this._artnet = {}; // entry_id -> netroni/artnet_status result, or {failed}
    this._mqtt = {}; // entry_id -> netroni/mqtt_status result, or {failed}
    this._sacn = {}; // entry_id -> netroni/sacn_status result, or {failed}
    this._circadian = {}; // entry_id -> netroni/circadian_status result, or {failed}
    this._relay = {}; // entry_id -> netroni/relay_status result, or {failed}
    this._dmxPct = false; // show values as % instead of 0-255
    this._dmxSel = null; // "entry|address" of the channel shown in the info line
    this._dmxSig = ""; // what the rendered grids are built from; a change means a full re-render
    this._busy = false;
    this._collapsed = loadCollapsed();
    this._focusMini =new URLSearchParams(location.search).get("mini"); // from a device page's "Configure"
    this._stateSig = "";
    this._ticks = 0;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div id="main"></div><div id="dialog"></div>`;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("input", (ev) => {
      if (this._dialog?.kind === "scene") {
        if (ev.target.id === "scene-name") this._dialog.name = ev.target.value;
        if (ev.target.id === "scene-start") this._dialog.transition = ev.target.value;
        if (ev.target.id === "scene-end") this._dialog.transitionEnd = ev.target.value;
        if (ev.target.dataset?.action === "scene-brightness") {
          const pct = this.shadowRoot.querySelector(`[data-pct="${CSS.escape(ev.target.dataset.key)}"]`);
          if (pct) pct.textContent = `${Math.round((Number(ev.target.value) / 255) * 100)} %`;
        }
        return;
      }
      if (ev.target.id === "dmx-start" && this._dialog?.kind === "dmx") {
        this._dialog.start = Number(ev.target.value);
        this._showDmxCheck();
        return;
      }
      if (ev.target.id !== "cct-warm" && ev.target.id !== "cct-cool") return;
      const { warm, cool } = this._cctInputs();
      Object.assign(this._dialog, { warm, cool, custom: true });
      const labels = this.shadowRoot.getElementById("cct-labels");
      if (labels && warm && cool) labels.innerHTML = this._cctLabels(warm, cool);
      const bar = this.shadowRoot.getElementById("cct-bar");
      if (bar && warm && cool) bar.style.background = this._cctGradient(warm, cool);
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
      if (this._tab === "remote") this._refreshRemote();
      if (this._tab !== "dmx") this._refreshDmx(); // is there DMX output to show a tab for?
      this._loadCircadian();
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
    if (this._tab === "settings" && this._ticks % ARTNET_POLL_S === 0) this._refreshArtnet();
    if (this._tab === "remote") {
      this._updateRemoteCountdowns();
      // While a pairing window is open, look often: the pairing appears as soon as it is made.
      const open = Object.keys(this._remoteClosesAt).length > 0;
      if (this._ticks % (open ? 2 : MATTER_POLL_S) === 0) this._refreshRemote();
    }
  }

  // --- events and actions -------------------------------------------------------------------

  _onIdentified(msg) {
    const key = `${msg.entry_id}|${msg.uid}|${msg.port}`;
    this._identified.set(key, { lightIds: msg.light_ids || [], until: Date.now() + HIGHLIGHT_MS });
    this._tab = "installation";
    const identifiedMaster = this._master(msg.entry_id);
    if (identifiedMaster) this._openCards(identifiedMaster, msg.uid); // the port must be visible
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
        if (this._tab === "remote") this._refreshRemote();
        if (this._tab === "settings") this._refreshArtnet();
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
      case "collapse":
        this._setCollapsed([d.key], !this._collapsed.has(d.key));
        break;
      case "collapse-all":
        this._setCollapsed(this._data.masters.map((m) => this._masterKey(m)), true);
        break;
      case "expand-all":
        this._setCollapsed([...this._collapsed].filter((k) => !k.startsWith("open:")), false);
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
      case "dmx": {
        const mini = this._mini(d.entry, d.uid);
        this._openDialog({ kind: "dmx", entry: d.entry, uid: d.uid, start: mini?.dmx_start, resolution: mini?.dmx_resolution || 8 });
        break;
      }
        break;
      case "confirm-dmx":
        this._setDmx();
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
        const light = this._master(d.entry)?.lights.find((l) => l.mini_uid === d.uid && l.key === `port${d.port}t`);
        this._openDialog({ kind: "cct", entry: d.entry, uid: d.uid, port: Number(d.port), warm: range[0], cool: range[1],
          light: light?.id, follows: this._follows(d.entry, light?.id) });
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
      case "goto-scene":
        ev.stopPropagation();
        this._tab = "scenes";
        this._stopDmxPoll();
        this._gotoScene = `${d.entry}|${d.scene}`;
        this._renderMain();
        requestAnimationFrame(() =>
          this.shadowRoot.getElementById(`scene-${d.entry}-${d.scene}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
        );
        clearTimeout(this._gotoTimer);
        this._gotoTimer = setTimeout(() => {
          this._gotoScene = null;
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
      case "new-scene":
        this._openDialog({ kind: "scene", entry: d.entry, sceneId: null, name: "", transition: "", transitionEnd: "", entries: {} });
        break;
      case "edit-scene": {
        const scene = this._master(d.entry)?.scenes.find((s) => s.id === d.scene);
        if (scene) {
          const entries = {};
          for (const e of scene.entries) entries[e.group ? `group:${e.group}` : `light:${e.light}`] = { ...e };
          this._openDialog({ kind: "scene", entry: d.entry, sceneId: scene.id, name: scene.name,
            transition: scene.transition == null ? "" : scene.transition / 1000,
            transitionEnd: scene.transition_end == null ? "" : scene.transition_end / 1000, entries });
        }
        break;
      }
      case "edit-input": {
        const pack = (this._master(d.entry)?.packs || []).find((p) => p.uid === d.uid);
        const given = pack?.inputs.find((i) => i.input === Number(d.input));
        if (given) {
          this._openDialog({ kind: "input", entry: d.entry, uid: d.uid, input: given.input, name: given.name || "",
            mode: given.mode, action: { ...given.action }, action_off: { ...given.action_off } });
        }
        break;
      }
      case "save-input":
        this._saveInput();
        break;
      case "recall-scene":
        this._hass
          .callService("scene", "turn_on", { entity_id: d.entity })
          .catch((err) => this._toast(err.message || String(err)));
        break;
      case "scene-now": {
        const master = this._master(this._dialog.entry);
        for (const key of Object.keys(this._dialog.entries)) this._dialog.entries[key] = this._sceneEntryNow(master, key);
        this._renderDialog();
        break;
      }
      case "save-scene":
        this._saveScene();
        break;
      case "delete-scene":
        this._deleteScene();
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
      case "remote-pair":
        this._remoteCall(d.entry, "netroni/remote_open_pairing");
        break;
      case "remote-cancel":
        this._remoteCall(d.entry, "netroni/remote_close_pairing");
        break;
      case "remote-rotate":
        if (confirm("Renew the keys? Every paired Home Assistant and app takes the new keys the next time it connects. One that doesn't connect within 90 days has to be paired again.")) {
          this._remoteCall(d.entry, "netroni/remote_rotate_keys");
        }
        break;
      case "remote-switch": {
        const status = this._remote[d.entry] || {};
        const confirmed = (status.key_rotation && status.key_rotation.confirmed) || [];
        const missing = (status.clients || []).filter((c) => !confirmed.includes(c.id)).map((c) => c.name);
        const who = missing.length ? ` ${missing.join(", ")} ${missing.length === 1 ? "doesn't" : "don't"} have them yet and will have to be paired again.` : "";
        if (confirm(`Switch to the new keys now?${who}`)) {
          this._remoteCall(d.entry, "netroni/remote_switch_keys");
        }
        break;
      }
      case "remote-revoke":
        if (confirm(`Remove ${d.name}? It can no longer control this XP-Master until it is paired again.`)) {
          this._remoteCall(d.entry, "netroni/remote_revoke", { client_id: d.client });
        }
        break;
      case "update-channel":
        this._setChannel(d.entry, d.channel);
        break;
      case "mqtt-save":
        this._saveMqtt(d.entry);
        break;
      case "circadian-save":
        this._saveCircadian(d.entry);
        break;
      case "circadian-suggest": {
        // Into the fields only: Save keeps it, as with a range typed in.
        const set = (name, value) => {
          const input = this.shadowRoot.getElementById(`circadian-${name}-${d.entry}`);
          if (input) input.value = value;
        };
        set("warmest", d.warm);
        set("coolest", d.cool);
        this._toast("Range filled in: Save to use it");
        break;
      }
      case "mqtt-clear-password":
        this._setMqtt(d.entry, { password: "" }).then((ok) => ok && this._toast("MQTT password removed"));
        break;
      case "artnet-universe": {
        const status = this._artnet[d.entry];
        this._openDialog({ kind: "universe", protocol: "artnet", entry: d.entry, value: status?.port_address ?? 1 });
        break;
      }
      case "sacn-universe": {
        const status = this._sacn[d.entry];
        this._openDialog({ kind: "universe", protocol: "sacn", entry: d.entry, value: status?.universe ?? 1 });
        break;
      }
      case "save-universe":
        this._saveUniverse();
        break;
      case "curve": {
        const mini = this._mini(d.entry, d.uid);
        this._openDialog({ kind: "curve", entry: d.entry, uid: d.uid, curve: mini?.dimming_curve ?? 6 });
        break;
      }
      case "save-curve":
        this._saveCurve();
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
    if (this._dialog?.kind === "input") {
      const d = this._dialog;
      if (el.name === "input-mode") {
        d.name = this.shadowRoot.getElementById("input-name")?.value ?? d.name;
        d.mode = el.value;
        this._renderDialog();
        return;
      }
      const which = { "input-action": "action", "input-action-off": "action_off" }[el.dataset?.action];
      if (which) {
        d.name = this.shadowRoot.getElementById("input-name")?.value ?? d.name;
        d[which] = this._actionFromValue(el.value, d[which]);
        this._renderDialog();
        return;
      }
    }
    if (el.name === "dmx-res" && this._dialog?.kind === "dmx") {
      this._pickDmxResolution(Number(el.value));
      return;
    }
    if (this._dialog?.kind === "scene") {
      const d = this._dialog;
      const key = el.dataset?.key;
      if (el.dataset?.action === "scene-member") {
        if (el.checked) d.entries[key] = this._sceneEntryNow(this._master(d.entry), key);
        else delete d.entries[key];
        this._renderDialog();
        return;
      }
      if (el.dataset?.action === "scene-on" && d.entries[key]) {
        d.entries[key].on = el.checked;
        return;
      }
      if (el.dataset?.action === "scene-brightness" && d.entries[key]) {
        d.entries[key].brightness = Math.max(1, Math.min(255, Number(el.value)));
        d.entries[key].on = true; // setting a brightness means on, as for a light
        this._renderDialog();
        return;
      }
      if (el.dataset?.action === "scene-kelvin" && d.entries[key]) {
        d.entries[key].kelvin = Math.round(Number(el.value)) || undefined;
        return;
      }
    }
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
    if (el.dataset?.action === "mqtt-enabled") {
      this._setMqtt(el.dataset.entry, { enabled: el.checked });
      return;
    }
    if (el.dataset?.action === "artnet-enabled" || el.dataset?.action === "artnet-pro") {
      const field = el.dataset.action === "artnet-enabled" ? "enabled" : "pro_mode";
      this._setArtnet(el.dataset.entry, { [field]: el.checked });
      return;
    }
    if (el.dataset?.action === "relay-enabled") {
      this._setRelay(el.dataset.entry, el.checked);
      return;
    }
    if (el.dataset?.action === "circadian-enabled") {
      this._setCircadian(el.dataset.entry, { enabled: el.checked });
      return;
    }
    if (el.dataset?.action === "sacn-enabled") {
      this._setSacn(el.dataset.entry, { enabled: el.checked });
      return;
    }
    if (el.name === "curve" && this._dialog?.kind === "curve") {
      this._dialog.curve = Number(el.value);
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

  async _saveScene() {
    const d = this._dialog;
    const name = (this.shadowRoot.getElementById("scene-name")?.value || "").trim();
    if (!name) {
      this._toast("Give the scene a name");
      return;
    }
    d.name = name;
    const seconds = (id) => {
      const text = this.shadowRoot.getElementById(id)?.value.trim();
      return text ? Number(text) : null; // empty: at once
    };
    const transition = seconds("scene-start"), transitionEnd = seconds("scene-end");
    if ([transition, transitionEnd].some((s) => s != null && !(s >= 0 && s <= 600))) {
      this._toast("A transition is 0 to 600 seconds");
      return;
    }
    const entries = Object.values(d.entries).map((e) => {
      const out = { on: !!e.on, brightness: e.brightness || 255 };
      if (e.group) out.group = e.group;
      else out.light = e.light;
      if (e.kelvin) out.kelvin = e.kelvin;
      return out;
    });
    const msg = { type: "netroni/scene_save", entry_id: d.entry, name, transition, transition_end: transitionEnd, entries };
    if (d.sceneId) msg.scene_id = d.sceneId;
    await this._run(() => this._call(msg));
  }

  async _deleteScene() {
    const d = this._dialog;
    if (!d.confirmDelete) {
      d.confirmDelete = true; // second click deletes
      this._renderDialog();
      return;
    }
    await this._run(() => this._call({ type: "netroni/scene_delete", entry_id: d.entry, scene_id: d.sceneId }));
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
    const follow = this.shadowRoot.getElementById("cct-circadian");
    const { light, follows } = this._dialog;
    await this._run(async () => {
      await this._call({ type: "netroni/set_cct_range", entry_id: entry, uid, port, warm, cool });
      if (follow && follow.checked !== follows) {
        const st = this._circadian[entry];
        const lights = new Set(st.lights || []);
        if (follow.checked) lights.add(light);
        else lights.delete(light);
        // A light that followed with its group, switched off here: its group no longer follows.
        const master = this._master(entry);
        const groups = (st.groups || []).filter((id) => follow.checked || !master?.groups.find((g) => g.id === id)?.members.includes(light));
        this._circadian[entry] = { places: st.places,
          ...(await this._call({ type: "netroni/circadian_set", entry_id: entry, lights: [...lights], groups })) };
      }
    });
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

  /** The DMX dialog's start and resolution: {ok, changed, text} for the line under the field. */
  _dmxCheck() {
    const { entry, uid, start, resolution } = this._dialog;
    const master = this._master(entry);
    const mini = this._mini(entry, uid);
    const last = 513 - dmxSize(resolution);
    if (!Number.isInteger(start) || start < 1 || start > last) {
      return { ok: false, text: `The start must be 1–${last} at ${resolution}-bit.` };
    }
    const end = start + dmxSize(resolution);
    const other = (master?.minis || []).find(
      (m) => m.uid !== uid && m.dmx_start && start < m.dmx_start + dmxSize(m.dmx_resolution) && m.dmx_start < end
    );
    if (other) {
      return { ok: false, text: `Channels ${dmxRange(start, resolution)} overlap ${esc(other.name)} (${dmxRange(other.dmx_start, other.dmx_resolution)}).` };
    }
    const changed = start !== mini?.dmx_start || resolution !== (mini?.dmx_resolution || 8);
    return { ok: true, changed, text: changed ? `Channels ${dmxRange(start, resolution)}: free.` : "Its current channels." };
  }

  _showDmxCheck() {
    const check = this._dmxCheck();
    const line = this.shadowRoot.getElementById("dmx-check");
    if (line) {
      line.innerHTML = check.text;
      line.classList.toggle("bad-text", !check.ok);
    }
    const save = this.shadowRoot.getElementById("dmx-save");
    if (save) save.disabled = this._busy || !check.ok || !check.changed;
  }

  /** Another resolution: keep the start where the block still fits, else the XP-Master's suggestion. */
  async _pickDmxResolution(resolution) {
    const d = this._dialog;
    d.resolution = resolution;
    try {
      const suggestion = await this._hass.callWS({ type: "netroni/suggest_dmx", entry_id: d.entry, uid: d.uid, resolution });
      if (this._dialog !== d) return;
      if (suggestion.start == null) d.full = true;
      else if (suggestion.moves || this._dmxCheck().ok === false) d.start = suggestion.start;
    } catch {
      // an XP-Master without suggest_dmx: the check line says what doesn't fit
    }
    this._renderDialog();
  }

  async _setDmx() {
    const { entry, uid, start, resolution } = this._dialog;
    if (!this._dmxCheck().changed) return;
    const name = this._miniName(this._master(entry), uid);
    await this._run(async () => {
      await this._call({ type: "netroni/set_dmx", entry_id: entry, uid, start, resolution });
      this._toast(`${name} now uses DMX ${dmxRange(start, resolution)} at ${resolution}-bit`);
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

  /** The XP-Masters, not the XP-Bridges: only an XP-Master has a Matter bridge and sends DMX. */
  get _xpMasters() {
    return (this._data?.masters || []).filter((m) => m.product !== "XP-Bridge");
  }

  async _refreshMatter() {
    for (const master of this._xpMasters) {
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

  async _refreshRemote() {
    for (const master of this._localMasters()) {
      try {
        this._setRemote(master.entry_id, await this._hass.callWS({ type: "netroni/remote_status", entry_id: master.entry_id }));
      } catch (err) {
        this._remote[master.entry_id] = { error: err.message || String(err) };
      }
    }
    if (this._tab === "remote") this._renderMain();
  }

  async _remoteCall(entry, type, fields = {}) {
    this._remote[entry] = { ...this._remote[entry], busy: true };
    this._renderMain();
    try {
      this._setRemote(entry, await this._call({ type, entry_id: entry, ...fields }));
    } catch {
      this._remote[entry] = { ...this._remote[entry], busy: false };
    }
    this._renderMain();
  }

  _setRemote(entry, status) {
    this._remote[entry] = status;
    if (status.pairing) this._remoteClosesAt[entry] = Date.now() + status.pairing.seconds_left * 1000;
    else delete this._remoteClosesAt[entry];
  }

  _updateRemoteCountdowns() {
    for (const [entry, closesAt] of Object.entries(this._remoteClosesAt)) {
      const left = Math.max(0, Math.round((closesAt - Date.now()) / 1000));
      const el = this.shadowRoot.getElementById(`remote-countdown-${entry}`);
      if (el) el.textContent = left ? `The code works for another ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.` : "The pairing window is closing…";
    }
  }

  // --- the Settings tab ----------------------------------------------------------------------

  async _refreshArtnet() {
    let changed = false;
    for (const master of this._xpMasters) {
      for (const [store, type] of [[this._relay, "netroni/relay_status"], [this._artnet, "netroni/artnet_status"], [this._sacn, "netroni/sacn_status"], [this._mqtt, "netroni/mqtt_status"], [this._circadian, "netroni/circadian_status"]]) {
        let status;
        try {
          status = await this._hass.callWS({ type, entry_id: master.entry_id });
        } catch (err) {
          status = { failed: err.message || String(err) };
        }
        // frames go up all the time while a sender sends: not a reason to draw again
        const sig = (s) => JSON.stringify({ ...s, frames: undefined });
        if (sig(status) !== sig(store[master.entry_id] || {})) changed = true;
        store[master.entry_id] = status;
      }
    }
    // Not while an MQTT or circadian field is being typed in: drawing again would lose it.
    const typing = this.shadowRoot.activeElement?.closest?.(".mqtt-form, .circadian-form");
    if (changed && this._tab === "settings" && !typing) this._renderMain();
  }

  async _setMqtt(entry, fields) {
    try {
      this._mqtt[entry] = await this._call({ type: "netroni/mqtt_set", entry_id: entry, ...fields });
      return true;
    } catch {
      return false;
    } finally {
      this._renderMain();
    }
  }

  async _saveMqtt(entry) {
    const value = (name) => this.shadowRoot.getElementById(`mqtt-${name}-${entry}`)?.value.trim() ?? "";
    const fields = { server: value("server"), username: value("username"), client_id: value("client"), prefix: value("prefix") };
    const password = this.shadowRoot.getElementById(`mqtt-password-${entry}`)?.value ?? "";
    if (password) fields.password = password; // empty: keep the one set
    if (await this._setMqtt(entry, fields)) this._toast("MQTT settings saved");
  }

  _mqttSection(master) {
    const entry = master.entry_id;
    const status = this._mqtt[entry];
    if (!status) return `<h4>MQTT</h4><div class="empty small">Loading…</div>`;
    if (status.failed) return `<h4>MQTT</h4>${this._banner("warn", "mdi:alert-outline", `MQTT settings could not be read: ${esc(status.failed)}`)}`;
    const lock = this._admin ? "" : "disabled";
    let line = "";
    if (status.enabled) {
      line = status.connected
        ? `Connected to <b>${esc(status.server)}</b> as ${esc(status.client_id_used)}. Topics start with <b>${esc(status.prefix_used)}/</b>.`
        : `Not connected${status.error ? `: ${esc(status.error)}` : ""}. The XP-Master keeps trying in the background; everything else works as usual.`;
    }
    const field = (name, label, value, placeholder = "", type = "text") => `
      <label class="field"><span>${label}</span>
        <input id="mqtt-${name}-${entry}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" ${lock}></label>`;
    return `
      <h4>MQTT</h4>
      <div class="set-row">
        <div class="grow"><div>MQTT</div><div class="sub">Publishes the lights, groups and scenes to an MQTT broker, and takes commands from it, for other systems (Node-RED, a building management system…). Not encrypted yet: use it on a network you trust.</div></div>
        <label class="tw"><input type="checkbox" data-action="mqtt-enabled" data-entry="${entry}" ${status.enabled ? "checked" : ""} ${lock || (status.server ? "" : "disabled title=\"Fill in the server first\"")}><span class="switch"></span></label>
      </div>
      ${line ? `<div class="sub pad">${line}</div>` : ""}
      <div class="mqtt-form">
        <div class="field-row">${field("server", "Server (host or host:port)", status.server, "e.g. 192.168.1.10:1883")}${field("prefix", "Topic prefix", status.prefix, status.prefix_used)}</div>
        <div class="field-row">${field("username", "Username", status.username)}${field("password", "Password", "", status.password_set ? "•••••••• (set; leave empty to keep it)" : "", "password")}</div>
        <div class="field-row">${field("client", "Client ID", status.client_id, status.client_id_used)}<div class="field"></div></div>
        ${this._admin ? `<div class="actions left"><button class="btn" data-action="mqtt-save" data-entry="${entry}">Save</button>
          ${status.password_set ? `<button class="btn secondary" data-action="mqtt-clear-password" data-entry="${entry}">Remove password</button>` : ""}</div>` : ""}
      </div>`;
  }

  async _setArtnet(entry, fields) {
    try {
      this._artnet[entry] = await this._call({ type: "netroni/artnet_set", entry_id: entry, ...fields });
    } catch {}
    this._renderMain(); // also puts a switch back when the change was refused
  }

  async _setSacn(entry, fields) {
    try {
      this._sacn[entry] = await this._call({ type: "netroni/sacn_set", entry_id: entry, ...fields });
    } catch {}
    this._renderMain(); // also puts a switch back when the change was refused
  }

  async _saveUniverse() {
    const { entry, protocol } = this._dialog;
    const [low, high] = UNIVERSES[protocol];
    const value = Number(this.shadowRoot.getElementById("universe-value")?.value);
    if (!Number.isInteger(value) || value < low || value > high) {
      this._toast(`The universe is a whole number, ${low}–${high}`);
      return;
    }
    await this._run(async () => {
      if (protocol === "sacn") this._sacn[entry] = await this._call({ type: "netroni/sacn_set", entry_id: entry, universe: value });
      else this._artnet[entry] = await this._call({ type: "netroni/artnet_set", entry_id: entry, port_address: value });
      this._renderMain();
    });
  }

  async _setChannel(entry, channel) {
    try {
      await this._call({ type: "netroni/update_channel", entry_id: entry, channel });
      this._toast(channel === "beta" ? "Beta releases will be offered" : "Only stable releases will be offered");
    } catch {}
  }

  async _saveCurve() {
    const { entry, uid, curve } = this._dialog;
    const mini = this._mini(entry, uid);
    const label = mini?.settings_offered?.dimming_curves?.[String(curve)] || String(curve);
    if (curve === mini?.dimming_curve) {
      this._closeDialog();
      return;
    }
    await this._run(async () => {
      await this._call({ type: "netroni/set_curve", entry_id: entry, uid, curve });
      this._toast(`${mini?.name || uid} now dims with ${label}`);
    });
  }

  _settingsCard(master) {
    const entry = master.entry_id;
    const xpMaster = master.product !== "XP-Bridge";
    const lock = this._admin ? "" : "disabled";
    // This Home Assistant's own XP-Master is reached on 127.0.0.1: its address on the network is the
    // one the Art-Net node reports, once read.
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(master.host);
    const host = loopback ? this._artnet[entry]?.address || "" : master.host;
    const device = master.device_id
      ? `<a class="fact-link" data-action="device" data-device="${esc(master.device_id)}" title="Rename it on its device page">${esc(master.name)}</a>`
      : esc(master.name);
    let html = `
      <h4>This ${esc(master.product || "XP-Master")}</h4>
      <div class="facts">
        ${this._fact("Name", device)}
        ${host ? this._fact(/[a-z]/i.test(host) ? "Address" : "IP address", esc(host)) : ""}
        ${this._fact("Serial", esc(master.master_id))}
        ${master.release ? this._fact("Software", esc(master.release)) : ""}
      </div>`;
    if (master.update_channel) {
      const seg = (channel, label) =>
        `<button class="seg-btn ${master.update_channel === channel ? "active" : ""}" data-action="update-channel" data-entry="${entry}" data-channel="${channel}" ${lock}>${label}</button>`;
      const available = master.update_available
        ? `<div class="sub pad">Release ${esc(master.update_available)} is available: <a class="fact-link" data-action="more-info" data-entity="${esc(master.firmware_entity || "")}">install it</a>.</div>`
        : "";
      html += `
        <h4>Firmware updates</h4>
        <div class="set-row">
          <div class="grow"><div>Update channel</div><div class="sub">Beta releases come earlier and are less tested: for test and demo installations.</div></div>
          <div class="seg">${seg("stable", "Stable")}${seg("beta", "Beta")}</div>
        </div>
        ${available}`;
    }
    if (master.minis.length) {
      // Each XP-Mini's own menu, as on its card in Installation: restart, DMX, dimming curve, reset, replace, remove.
      html += `<h4>XP-Minis</h4>${master.minis
        .map((mini) => `
          <div class="set-row">
            <div class="grow"><div>${esc(mini.name)}</div>
              <div class="sub">${esc(mini.hardware_uid || mini.uid)} · ${mini.online ? `firmware ${esc(mini.firmware || "?")}` : "offline"}</div></div>
            <button class="btn secondary" data-action="mini-actions" data-entry="${entry}" data-uid="${esc(mini.uid)}" ${this._admin ? "" : "disabled"}
              title="Restart, DMX, dimming curve, factory reset, replace or remove">Manage…</button>
          </div>`)
        .join("")}`;
    }
    if (xpMaster) {
      html += this._fold(entry, "circadian", "mdi:weather-sunset", "Circadian lighting", this._circadianSummary(entry),
        () => this._circadianSection(master).replace(/^\s*<h4>[^<]*<\/h4>/, ""));
      html += this._fold(entry, "remote", "mdi:earth", "Remote access", this._relaySummary(entry),
        () => this._relaySection(master).replace(/^\s*<h4>[^<]*<\/h4>/, ""));
      html += this._fold(entry, "protocols", "mdi:lan", "Network protocols", this._protocolsSummary(entry),
        () => [this._artnetSection(master), this._sacnSection(master), this._proModeSection(master), this._mqttSection(master)]
          .filter(Boolean).map((part) => `<div class="sub-card">${part}</div>`).join(""));
    }
    if (!this._admin) html += `<p class="sub pad">An administrator can change these settings.</p>`;
    return `
      <section class="card">
        <div class="card-head">
          <ha-icon class="head-icon" icon="mdi:cog-outline"></ha-icon>
          <div class="grow"><h2>${esc(master.name)}</h2><div class="sub">${esc(master.product || "XP-Master")} settings</div></div>
        </div>
        ${html}
      </section>`;
  }

  /** A Settings section that opens and closes; closed (the start) it shows only its summary line. */
  _fold(entry, name, icon, title, summary, body) {
    const key = `open:${entry}/${name}`;
    const open = this._collapsed.has(key);
    return `
      <div class="settings-fold ${open ? "open" : ""}">
        <div class="fold-head fold" data-action="collapse" data-key="${esc(key)}" role="button" aria-expanded="${open}">
          <ha-icon class="fold-chevron" icon="${open ? "mdi:chevron-down" : "mdi:chevron-right"}"></ha-icon>
          <ha-icon class="fold-icon" icon="${icon}"></ha-icon>
          <div class="grow"><div class="fold-title">${title}</div>${summary ? `<div class="sub">${summary}</div>` : ""}</div>
        </div>
        ${open ? `<div class="fold-body">${body()}</div>` : ""}
      </div>`;
  }

  _circadianSummary(entry) {
    const st = this._circadian[entry];
    if (!st) return "";
    if (st.failed) return "Could not be read";
    if (!st.enabled) return "Off";
    if (st.error) return `On · not running: ${esc(st.error)}`;
    const where = st.place_name ? ` · sun of ${esc(st.place_name)}` : "";
    return `On · ${st.kelvin ? `${st.kelvin} K now` : "starting"} · ${st.following} light${st.following === 1 ? "" : "s"}${where}`;
  }

  _relaySummary(entry) {
    const st = this._relay[entry];
    if (!st) return "";
    if (st.failed) return "Could not be read";
    if (!st.enabled) return "Off";
    if (st.paired === false) return "On · pair an app at home first";
    return st.connected ? "On · reachable from outside the home" : "On · not reachable right now";
  }

  _protocolsSummary(entry) {
    const art = this._artnet[entry];
    const sacn = this._sacn[entry];
    const mqtt = this._mqtt[entry];
    const part = (name, st, on) => (!st ? "" : st.failed ? `${name} ?` : st.enabled ? `${name} ${on(st)}` : `${name} off`);
    return [
      part("Art-Net", art, (st) => `on (universe ${esc(st.port_address)})`),
      part("sACN", sacn, (st) => `on (universe ${esc(st.universe)})`),
      art && !art.failed && art.pro_mode ? "Pro Mode" : "",
      part("MQTT", mqtt, (st) => (st.connected ? "connected" : "not connected")),
    ].filter(Boolean).join(" · ");
  }

  _artnetSection(master) {
    const entry = master.entry_id;
    const status = this._artnet[entry];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.failed) body = this._banner("warn", "mdi:alert-outline", `Art-Net settings could not be read: ${esc(status.failed)}`);
    else {
      const lock = this._admin ? "" : "disabled";
      const lines = [];
      if (status.error) lines.push(`Not running: ${esc(status.error)}.`);
      else if (status.enabled && status.listening) {
        lines.push(`Senders send to <b>${esc(status.address)}</b>.`);
        lines.push(status.receiving ? `Receiving from <b>${esc(status.source)}</b>.` : "Nothing received for this universe.");
        if (status.second_source) lines.push(`${esc(status.second_source)} also sends to this universe and is ignored.`);
        if (status.held_by) lines.push(heldBy(status.held_by, "Art-Net"));
        const other = status.other_universe;
        if (other) {
          const address = other.port_address ?? (other.net << 8 | other.subnet << 4 | other.universe);
          lines.push(`${esc(other.source)} sends to universe ${address}, which this XP-Master doesn't respond as.`);
        }
      }
      body = `
        <div class="set-row">
          <div class="grow"><div>Art-Net</div><div class="sub">Lets a lighting console or program control the lights over the network. Art-Net has no password: anyone on this network can then set the lights and change the XP-Minis' DMX settings.</div></div>
          <label class="tw"><input type="checkbox" data-action="artnet-enabled" data-entry="${entry}" ${status.enabled ? "checked" : ""} ${lock}><span class="switch"></span></label>
        </div>
        <div class="set-row">
          <div class="grow"><div>Universe</div><div class="sub">The universe this XP-Master responds as, 0–32767. Some consoles count their universes from 1.</div></div>
          <div class="set-value">${esc(status.port_address)}</div>
          <button class="btn secondary" data-action="artnet-universe" data-entry="${entry}" ${lock}>Change</button>
        </div>
        ${lines.length ? `<div class="sub pad">${lines.join(" ")}</div>` : ""}`;
    }
    return `<h4>Art-Net</h4>${body}`;
  }

  _sacnSection(master) {
    const entry = master.entry_id;
    const status = this._sacn[entry];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.failed) body = this._banner("warn", "mdi:alert-outline", `sACN settings could not be read: ${esc(status.failed)}`);
    else {
      const lock = this._admin ? "" : "disabled";
      const lines = [];
      if (status.error) lines.push(`Not running: ${esc(status.error)}.`);
      else if (status.enabled && status.listening) {
        lines.push(status.multicast
          ? `Consoles send by multicast (${esc(status.multicast)}) or to <b>${esc(status.address)}</b>.`
          : `Consoles send to <b>${esc(status.address)}</b> (multicast could not be joined).`);
        lines.push(status.receiving
          ? `Receiving from <b>${esc(status.source)}</b>${status.source_name ? ` (${esc(status.source_name)})` : ""}, priority ${esc(status.priority)}.`
          : "Nothing received for this universe.");
        if (status.second_source) lines.push(`${esc(status.second_source)} also sends to this universe and is ignored: its priority is not higher.`);
        if (status.held_by) lines.push(heldBy(status.held_by, "sACN"));
        const other = status.other_universe;
        if (other) lines.push(`${esc(other.source)} sends to universe ${esc(other.universe)}, which this XP-Master doesn't listen to.`);
      }
      body = `
        <div class="set-row">
          <div class="grow"><div>sACN</div><div class="sub">Lets a lighting console or program control the lights over the network, with a backup console taking over by priority. sACN has no password: anyone on this network can then set the lights.</div></div>
          <label class="tw"><input type="checkbox" data-action="sacn-enabled" data-entry="${entry}" ${status.enabled ? "checked" : ""} ${lock}><span class="switch"></span></label>
        </div>
        <div class="set-row">
          <div class="grow"><div>Universe</div><div class="sub">The sACN universe this XP-Master listens to, 1–63999.</div></div>
          <div class="set-value">${esc(status.universe)}</div>
          <button class="btn secondary" data-action="sacn-universe" data-entry="${entry}" ${lock}>Change</button>
        </div>
        ${lines.length ? `<div class="sub pad">${lines.join(" ")}</div>` : ""}`;
    }
    return `<h4>sACN</h4>${body}`;
  }

  /** Circadian status of each XP-Master not read yet (the Settings tab keeps it fresh). */
  async _loadCircadian() {
    let changed = false;
    for (const master of this._xpMasters) {
      if (this._circadian[master.entry_id]) continue;
      try {
        this._circadian[master.entry_id] = await this._hass.callWS({ type: "netroni/circadian_status", entry_id: master.entry_id });
      } catch (err) {
        this._circadian[master.entry_id] = { failed: err.message || String(err) };
      }
      changed = true;
    }
    if (changed && !this._dialog) this._renderMain();
  }

  /** Whether this light follows circadian: true / false, or null when it can't (no circadian here). */
  _follows(entry, lightId) {
    const st = this._circadian[entry];
    if (!st || st.failed || !lightId) return null;
    const master = this._master(entry);
    const inGroup = (master?.groups || []).some((g) => (st.groups || []).includes(g.id) && g.members.includes(lightId));
    return (st.lights || []).includes(lightId) || inGroup;
  }

  async _setCircadian(entry, fields) {
    try {
      const places = this._circadian[entry]?.places; // only circadian/get has them
      this._circadian[entry] = { places, ...(await this._call({ type: "netroni/circadian_set", entry_id: entry, ...fields })) };
      return true;
    } catch {
      return false;
    } finally {
      this._renderMain(); // also puts a switch back when the change was refused
    }
  }

  async _saveCircadian(entry) {
    const value = (name) => this.shadowRoot.getElementById(`circadian-${name}-${entry}`)?.value ?? "";
    const warmest = Number(value("warmest"));
    const coolest = Number(value("coolest"));
    if (!Number.isInteger(warmest) || !Number.isInteger(coolest) || warmest < 1000 || coolest > 10000 || warmest >= coolest) {
      this._toast("Warmest and coolest: whole numbers in kelvin, 1000–10000, warmest below coolest");
      return;
    }
    const fields = { curve: value("curve"), warmest, coolest, warm_until: value("until"), place: value("place") };
    if (await this._setCircadian(entry, fields)) this._toast("Circadian settings saved");
  }

  _circadianSection(master) {
    const entry = master.entry_id;
    const status = this._circadian[entry];
    if (!status) return `<h4>Circadian lighting</h4><div class="empty small">Loading…</div>`;
    if (status.failed) return `<h4>Circadian lighting</h4>${this._banner("warn", "mdi:alert-outline", `Circadian settings could not be read: ${esc(status.failed)}`)}`;
    const lock = this._admin ? "" : "disabled";
    const lightName = (id) => {
      const light = master.lights.find((l) => l.id === id);
      return light ? light.name || light.default_name : id;
    };
    let line = "";
    if (status.enabled) {
      if (status.error) line = `Not running: ${esc(status.error)}.`;
      else if (status.kelvin) {
        const where = status.place_name ? ` in ${esc(status.place_name)}` : "";
        line = `Now <b>${status.kelvin} K</b>. Sunrise${where} ${esc(status.sunrise || "–")}, sunset ${esc(status.sunset || "after midnight")}.`;
        if (!status.following) line += " No light follows yet.";
        if (status.paused?.length) line += ` Set by hand, paused until switched off: ${status.paused.map((id) => esc(lightName(id))).join(", ")}.`;
      }
    }
    const option = (value, label, current) => `<option value="${esc(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
    const curves = [["home", "Home: slow mornings, warm evenings"], ["office", "Office: cooler working light"], ["natural", "Natural: the real sun"]];
    const places = [["", `Home location${status.home_name ? ` (${status.home_name})` : ""}`], ...(status.places || []).map((p) => [p.key, p.name])];
    const following = master.lights.filter((l) => l.kind === "tunable_white" && this._follows(entry, l.id)).map((l) => l.id);
    // Each light keeps the curve's value inside its own range: say where one can't follow it all the way.
    const ranges = following.map((id) => master.lights.find((l) => l.id === id))
      .filter((l) => l.min_kelvin && l.max_kelvin);
    const limits = ranges.flatMap((l) => {
      const parts = [];
      if (l.min_kelvin > status.warmest) parts.push(`at night it stays at ${l.min_kelvin} K`);
      if (l.max_kelvin < status.coolest) parts.push(`by day it goes no higher than ${l.max_kelvin} K`);
      return parts.length ? [`${esc(lightName(l.id))} (${l.min_kelvin}–${l.max_kelvin} K): ${parts.join(", ")}.`] : [];
    });
    // A range they can all show: the warmest they share, and their shared coolest (Home: at most 4000 K).
    let suggest = "";
    if (ranges.length) {
      const warm = Math.max(...ranges.map((l) => l.min_kelvin));
      const shared = Math.min(...ranges.map((l) => l.max_kelvin));
      const cool = status.curve === "home" ? Math.min(shared, 4000) : shared;
      if (warm >= cool) suggest = "These lights share no colour range: each follows within its own.";
      else if (warm !== status.warmest || cool !== status.coolest) {
        suggest = `Suggested for these lights: ${warm}–${cool} K${status.curve === "home" && shared > 4000 ? " (they reach " + shared + " K; Home stays at 4000 K or below)" : ""}.
          ${this._admin ? `<button class="link" data-action="circadian-suggest" data-entry="${entry}" data-warm="${warm}" data-cool="${cool}">Use it</button>` : ""}`;
      }
    }
    return `
      <h4>Circadian lighting</h4>
      <div class="set-row">
        <div class="grow"><div>Circadian lighting</div><div class="sub">Changes the colour temperature of the chosen lights through the day, following the sun: cooler by day, warmer in the evening. Only the colour temperature: switching and brightness stay as they are. A colour temperature set by hand pauses a light until it is switched off.</div></div>
        <label class="tw"><input type="checkbox" data-action="circadian-enabled" data-entry="${entry}" ${status.enabled ? "checked" : ""} ${lock}><span class="switch"></span></label>
      </div>
      ${line ? `<div class="sub pad">${line}</div>` : ""}
      <div class="circadian-form">
        <div class="field-row">
          <label class="field"><span>Curve</span><select id="circadian-curve-${entry}" ${lock}>${curves.map(([v, l]) => option(v, l, status.curve)).join("")}</select></label>
          <label class="field"><span>Follow the sun of</span><select id="circadian-place-${entry}" ${lock}>${places.map(([v, l]) => option(v, l, status.place)).join("")}</select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Warmest, at night (K)</span><input id="circadian-warmest-${entry}" type="number" step="10" value="${esc(status.warmest)}" ${lock}></label>
          <label class="field"><span>Coolest, by day (K)</span><input id="circadian-coolest-${entry}" type="number" step="10" value="${esc(status.coolest)}" ${lock}></label>
          <label class="field"><span>Warm until (Home)</span><input id="circadian-until-${entry}" type="time" min="18:00" max="23:59" value="${esc(status.warm_until)}" ${lock}></label>
        </div>
        ${suggest ? `<div class="sub pad">${suggest}</div>` : ""}
        ${this._admin ? `<div class="actions left"><button class="btn" data-action="circadian-save" data-entry="${entry}">Save</button></div>` : ""}
      </div>
      <div class="set-row"><div class="grow"><div>Which lights follow</div><div class="sub">${
        following.length ? `${following.map((id) => esc(lightName(id))).join(", ")}.` : "None yet."}
        Choose per port in Installation: a tunable white port's colour range → <i>Follow circadian lighting</i>.</div>
        ${limits.length ? `<div class="sub warn-text">${limits.join(" ")}</div>` : ""}</div></div>`;
  }

  _relaySection(master) {
    const entry = master.entry_id;
    const status = this._relay[entry];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.failed) body = this._banner("warn", "mdi:alert-outline", `Access from outside the home could not be read: ${esc(status.failed)}`);
    else {
      const lock = this._admin ? "" : "disabled";
      const lines = [];
      if (status.enabled) {
        if (status.paired === false) lines.push("Pair an app at home first.");
        else if (!status.connected) lines.push(`Not reachable${status.error ? `: ${esc(status.error)}` : ""}. Retrying…`);
        else if (status.apps?.length) lines.push(`In use from outside: ${status.apps.map(esc).join(", ")}.`);
        else lines.push("Reachable from outside the home.");
      }
      body = `
        <div class="set-row">
          <div class="grow"><div>Access from outside the home</div><div class="sub">Lets the Netroni apps control this XP-Master from anywhere, through the Visiolite relay. Every app paired with it can use this. The connection stays encrypted from the app to the XP-Master: the relay can't read it.</div></div>
          <label class="tw"><input type="checkbox" data-action="relay-enabled" data-entry="${entry}" ${status.enabled ? "checked" : ""} ${lock}><span class="switch"></span></label>
        </div>
        ${lines.length ? `<div class="sub pad">${lines.join(" ")}</div>` : ""}`;
    }
    return `<h4>Remote access</h4>${body}`;
  }

  async _setRelay(entry, enabled) {
    try {
      this._relay[entry] = await this._call({ type: "netroni/relay_set", entry_id: entry, enabled });
    } catch {}
    this._renderMain(); // also puts the switch back when the change was refused
  }

  /** One Pro Mode for Art-Net and sACN (kept with Art-Net's settings). */
  _proModeSection(master) {
    const entry = master.entry_id;
    const status = this._artnet[entry];
    if (!status || status.failed) return "";
    const lock = this._admin ? "" : "disabled";
    return `
      <h4>Pro Mode</h4>
      <div class="set-row">
        <div class="grow"><div>Pro Mode</div><div class="sub">For Art-Net and sACN, in light installations with frequent changes: the XP-Minis save the values at most every 5 minutes, which spares their memory. Off: values are saved right away, as from the app.</div></div>
        <label class="tw"><input type="checkbox" data-action="artnet-pro" data-entry="${entry}" ${status.pro_mode ? "checked" : ""} ${lock}><span class="switch"></span></label>
      </div>`;
  }

  /** XP-Masters this Home Assistant runs on (remote access is set up there, not from a paired one). */
  _localMasters() {
    return (this._data?.masters || []).filter((m) => !m.remote);
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
      for (const master of this._xpMasters) {
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
        return [m.entry_id, snap.output, snap.error, snap.fixed, (snap.blocks || []).map((b) => [b.dmx_start, b.dmx_resolution, b.name])];
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
    const block = (snap.blocks || []).find((b) => addr >= b.dmx_start && addr < b.dmx_start + dmxSize(b.dmx_resolution));
    if (!block) return "Not used";
    const offset = addr - block.dmx_start;
    const bits16 = block.dmx_resolution === 16;
    const output = bits16 ? offset >> 1 : offset;
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
    const chip = snap.bridge?.connected === false
      ? this._chip(false, "", "No bridge connected") // e.g. no BRIDGE Pico on the bench
      : this._chip(!snap.errors, "Sending", "Frames failing");
    return `${chip}
      ${this._fact("Port", esc(snap.device))}
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
      const why = snap.error ? esc(snap.error) : `This ${esc(master.product || "XP-Master")} doesn't send DMX itself.`;
      return `<section class="card">${head}<div class="sub pad">${why}</div></section>`;
    }
    const entry = master.entry_id;
    // Each line of 16 channels: its first channel, and the XP-Minis whose blocks start on it.
    let labels = "";
    for (let row = 1; row <= DMX_SLOTS; row += DMX_ROW) {
      const names = (snap.blocks || [])
        .filter((b) => b.dmx_start >= row && b.dmx_start < row + DMX_ROW)
        .sort((a, b) => a.dmx_start - b.dmx_start)
        .map((b) => (b.dmx_start === row ? esc(b.name) : `${b.dmx_start} ${esc(b.name)}`));
      labels += `<div class="dmx-label" title="${names.join(" · ")}">${row}${names.length ? ` <span>${names.join(" · ")}</span>` : ""}</div>`;
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

  // --- closed cards (Installation tab) ------------------------------------------------------

  _masterKey(master) {
    return `master:${master.master_id}`;
  }

  _miniKey(master, uid) {
    return `mini:${master.master_id}/${uid}`;
  }

  _setCollapsed(keys, closed) {
    for (const key of keys) {
      if (closed) this._collapsed.add(key);
      else this._collapsed.delete(key);
    }
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this._collapsed]));
    } catch (_err) {
      // private window or storage blocked: closed until the page is reloaded
    }
    this._renderMain();
  }

  /** Open an XP-Mini's card and its XP-Master's (without drawing: the caller does). */
  _openCards(master, uid) {
    const keys = [this._masterKey(master), this._miniKey(master, uid)].filter((k) => this._collapsed.has(k));
    if (!keys.length) return;
    for (const key of keys) this._collapsed.delete(key);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this._collapsed]));
    } catch (_err) {}
  }

  _chevron(key, label) {
    const open = !this._collapsed.has(key);
    return `<button class="icon-btn small chevron" data-action="collapse" data-key="${esc(key)}" aria-expanded="${open}"
      title="${open ? "Hide" : "Show"} ${label}"><ha-icon icon="${open ? "mdi:chevron-down" : "mdi:chevron-right"}"></ha-icon></button>`;
  }

  /** On a closed XP-Mini card, instead of its ports: "8 lights · 2 on". */
  _miniSummary(master, mini) {
    const lights = master.lights.filter((l) => l.mini_uid === mini.uid);
    const states = lights.map((l) => this._hass.states[l.entity_id]?.state);
    const on = states.filter((s) => s === "on").length;
    let text = `${lights.length} ${lights.length === 1 ? "light" : "lights"}`;
    if (!mini.online || states.every((s) => !s || s === "unavailable")) text += " · unavailable";
    else text += on ? ` · <b>${on} on</b>` : " · all off";
    return `<div class="summary sub">${text}</div>`;
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
        ${this._tabButton("scenes", "Scenes")}
        ${this._xpMasters.length ? this._tabButton("matter", "Matter") : ""}
        ${this._localMasters().length ? this._tabButton("remote", "Remote Access") : ""}
        ${this._hasDmx || this._tab === "dmx" ? this._tabButton("dmx", "DMX Output") : ""}
        ${this._tabButton("settings", "Settings")}
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
    if (this._tab === "matter") return this._xpMasters.map((m) => this._matterCard(m)).join("");
    if (this._tab === "remote") return this._localMasters().map((m) => this._remoteCard(m)).join("");
    if (this._tab === "groups") return this._data.masters.map((m) => this._groupsCard(m)).join("");
    if (this._tab === "scenes") return this._data.masters.map((m) => this._scenesCard(m)).join("");
    if (this._tab === "dmx") return this._xpMasters.map((m) => this._dmxCard(m)).join("");
    if (this._tab === "settings") return this._data.masters.map((m) => this._settingsCard(m)).join("");
    const minis = this._data.masters.reduce((n, m) => n + m.minis.length, 0);
    const bar = minis
      ? `<div class="fold-bar">
          <button class="btn secondary small" data-action="collapse-all" title="Show only the XP-Masters">Collapse all</button>
          <button class="btn secondary small" data-action="expand-all" ${this._collapsed.size ? "" : "disabled"}>Expand all</button>
        </div>`
      : "";
    return bar + this._data.masters.map((m) => this._installation(m)).join("");
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
    // Coming from an XP-Mini's device page: that one is shown, whatever was closed.
    if (this._focusMini && master.minis.some((m) => m.uid === this._focusMini)) this._openCards(master, this._focusMini);
    const key = this._masterKey(master);
    const closed = this._collapsed.has(key);
    const hidden = closed && master.minis.length
      ? `<button class="summary link" data-action="collapse" data-key="${esc(key)}">${master.minis.length} ${master.minis.length === 1 ? "XP-Mini" : "XP-Minis"} hidden · show</button>`
      : "";
    const head = `
      <section class="card">
        <div class="card-head">
          ${this._chevron(key, "its XP-Minis")}
          <ha-icon class="head-icon" icon="netroni:logo"></ha-icon>
          <div class="grow fold" data-action="collapse" data-key="${esc(key)}">
            <h2>${esc(master.name)}</h2>
            <div class="sub">${esc(master.product || "XP-Master")} · ${esc(master.master_id)}${master.area ? ` · ${esc(master.area)}` : ""}</div>
          </div>
          ${this._chip(master.connected, "Connected", "Not connected")}
          ${master.device_id ? this._deviceLink(master.device_id) : ""}
        </div>
        <div class="facts">
          ${this._fact("Address", esc(master.host))}
          ${this._fact("XP-Minis", `${master.minis.length}${offline ? ` <span class="warn-text">(${offline} offline)</span>` : ""}`)}
          ${this._fact("Lights", master.lights.length)}
          ${this._fact("Tunable-white ports", tw)}
          ${this._fact("Firmware", this._firmware(master))}
        </div>
        ${hidden}
      </section>`;
    // By DMX start address, as a console is patched; one without an address (DMX full) last.
    const byDmx = [...master.minis].sort((a, b) => (a.dmx_start || Infinity) - (b.dmx_start || Infinity));
    return closed ? head : head + byDmx.map((mini) => this._miniCard(master, mini)).join("");
  }

  /** An XP-Mini's firmware, as the XP-Master's: an update available, or how it is going. */
  _miniFirmware(mini) {
    const firmware = esc(mini.firmware || "—");
    let extra = "";
    if (mini.update_state === "receiving") extra = `updating… ${mini.update_progress || 0} %`;
    else if (mini.update_state === "restarting") extra = "restarting…";
    else if (mini.update_state === "failed" && mini.update_available) extra = "update failed";
    else if (mini.update_available) extra = `${esc(mini.update_available)} available`;
    if (!extra) return firmware;
    const label = mini.firmware_entity
      ? `<a class="fact-link" data-action="more-info" data-entity="${esc(mini.firmware_entity)}">${extra}</a>`
      : extra;
    return `${firmware} · ${label}`;
  }

  _firmware(master) {
    const release = master.release ? esc(master.release) : "—";
    let extra = "";
    if (master.update_state === "downloading" || master.update_state === "installing") extra = "updating…";
    else if (master.update_state === "failed") extra = "update failed";
    else if (master.update_available) extra = `${esc(master.update_available)} available`;
    if (!extra) return release;
    const label = master.firmware_entity
      ? `<a class="fact-link" data-action="more-info" data-entity="${esc(master.firmware_entity)}">${extra}</a>`
      : extra;
    return `${release} · ${label}`;
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
    const key = this._miniKey(master, mini.uid);
    const closed = this._collapsed.has(key);
    return `
      <section class="card mini ${mini.online ? "" : "offline"} ${this._focused === mini.uid ? "focused" : ""}" id="mini-${esc(mini.uid)}">
        <div class="card-head">
          ${this._chevron(key, "its ports")}
          <ha-icon class="head-icon mini-icon" icon="netroni:xp-mini"></ha-icon>
          <div class="grow fold" data-action="collapse" data-key="${esc(key)}">
            <h3>${esc(mini.name)}</h3>
            <div class="sub">XP-Mini · ${esc(mini.uid)}${mini.hardware_uid && mini.hardware_uid !== mini.uid ? ` (unit ${esc(mini.hardware_uid)})` : ""}${mini.area ? ` · ${esc(mini.area)}` : ""}</div>
          </div>
          ${gear}
          ${this._chip(mini.online, "Online", "Offline")}
          ${mini.device_id ? this._deviceLink(mini.device_id) : ""}
        </div>
        <div class="facts">
          ${this._fact("DMX", `${dmxRange(mini.dmx_start, mini.dmx_resolution || 8)} · ${mini.dmx_resolution || 8}-bit`)}
          ${this._fact("Firmware", this._miniFirmware(mini))}
          ${this._fact("Tunable-white ports", mini.pairs.length ? mini.pairs.map((p) => `${p}T`).join(", ") : "none")}
        </div>
        ${offline}
        ${closed ? this._miniSummary(master, mini) : `<div class="ports">${ports}</div>`}
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
    const light = master.lights.find((l) => l.mini_uid === mini.uid && l.key === `port${port}t`);
    const label = cctLabel(range) + (this._follows(master.entry_id, light?.id)
      ? ` <ha-icon class="chip-sun" icon="mdi:weather-sunset" title="Follows circadian lighting"></ha-icon>` : "");
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
    // In a group that switched it on or set it last (follows_level; an older XP-Master doesn't say:
    // every light follows): it gives out its own brightness × the group's level, as the app shows.
    let levelLine = "";
    const group = light.group && (master.groups || []).find((g) => g.id === light.group);
    if (on && group && st.attributes.follows_level !== false) {
      const own = Number(st.attributes.brightness ?? 255) || 255;
      const level = Number(this._hass.states[group.entity_id]?.attributes.brightness ?? 255) || 255;
      const out = st.attributes.output_brightness ?? Math.round((own * level) / 255);
      const pct = (v) => `${Math.round((v / 255) * 100)} %`;
      state = pct(out);
      levelLine = `<div class="light-sub">${pct(own)} × ${esc(group.name)} ${pct(level)}</div>`;
    }
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
          ${levelLine}${this._groupChip(master, light)}${this._sceneChips(master, light)}
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

  /** Under a light that is in scenes, itself or through its group: their names; a click opens one in the Scenes tab. */
  _sceneChips(master, light) {
    return (master.scenes || [])
      .filter((s) => s.entries.some((e) => e.light === light.id || (e.group && e.group === light.group)))
      .map((s) => `<button class="group-chip" data-action="goto-scene" data-entry="${master.entry_id}" data-scene="${esc(s.id)}"
        title="In the scene ${esc(s.name)}: open it"><ha-icon icon="mdi:palette-outline"></ha-icon>${esc(s.name)}</button>`)
      .join("");
  }

  _groupsCard(master) {
    const groups = master.groups || [];
    const intro = groups.length
      ? ""
      : `<section class="card"><div class="card-head"><ha-icon class="head-icon" icon="mdi:lightbulb-group-outline"></ha-icon>
          <div class="grow"><h2>Groups</h2><div class="sub">${esc(master.name)} · Lights set together: each keeps its own brightness; switched on or set with the group, it gives out its brightness × the group's level, switched or set by itself just its brightness.</div></div></div>
          <div class="sub pad">No groups yet.</div></section>`;
    const add = this._admin
      ? `<div class="actions"><button class="btn" data-action="new-group" data-entry="${master.entry_id}">New group</button></div>`
      : "";
    // With several XP-Masters: each one's groups under its name, with room before the next one.
    const title = this._data.masters.length > 1 ? `<h2 class="master-title">${esc(master.name)}</h2>` : "";
    return `<div class="master-block">${title}${intro}${groups.map((g) => this._groupCard(master, g)).join("")}${add}</div>`;
  }

  _groupCard(master, group) {
    const gst = this._hass.states[group.entity_id];
    const groupLevel = Number(gst?.attributes.level ?? gst?.attributes.brightness ?? 255);
    const on = gst?.state === "on";
    const partly = gst?.attributes.partly_on === true;
    const members = group.members.map((id) => master.lights.find((l) => l.id === id)).filter(Boolean);
    const minis = new Set(members.map((l) => l.mini_uid)).size;
    const pct = (v) => `${Math.round((v / 255) * 100)} %`;
    const rows = members
      .map((light) => {
        const st = this._hass.states[light.entity_id];
        const unavailable = !st || st.state === "unavailable";
        const lit = st?.state === "on";
        const own = Number(st?.attributes.brightness ?? 0) || 0;
        // × the level only while the group switched it on or set it last (follows_level; an older
        // XP-Master doesn't say: every light follows); set alone, exactly its own brightness.
        const follows = st?.attributes.follows_level !== false;
        const out = lit ? Math.round((own * groupLevel) / 255) : 0;
        const mini = this._miniName(master, light.mini_uid);
        return `
          <div class="grow-row ${lit ? "on" : ""}">
            <button class="lamp" data-action="toggle" data-entity="${esc(light.entity_id)}" ${unavailable ? "disabled" : ""}><ha-icon icon="mdi:lightbulb-outline"></ha-icon></button>
            <div class="gr-name"><div class="light-name">${esc(light.name || light.default_name)}</div><div class="light-sub">${esc(mini)} · ${light.key.replace("port", "").toUpperCase()}</div></div>
            <input class="slider own" type="range" min="1" max="255" value="${own || 255}" data-action="dim" data-entity="${esc(light.entity_id)}" ${unavailable ? "disabled" : ""}>
            <div class="gr-pct">${unavailable ? "Unavailable" : !lit ? "Off" : follows ? `own ${pct(own)} → <b>${pct(out)}</b>` : `<b>${pct(own)}</b>`}</div>
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
        <div class="grow-row group-level ${on ? "on" : partly ? "partly" : ""}">
          <button class="lamp" data-action="toggle" data-entity="${esc(group.entity_id)}" ${gst ? "" : "disabled"}><ha-icon icon="mdi:lightbulb-group-outline"></ha-icon></button>
          <div class="gr-name"><div class="light-name"><b>Group</b></div><div class="light-sub">dims all members together</div></div>
          <input class="slider" type="range" min="1" max="255" value="${groupLevel}" data-action="dim" data-entity="${esc(group.entity_id)}" ${gst ? "" : "disabled"}>
          <div class="gr-pct"><b>${on ? pct(groupLevel) : partly ? `Partly on, ${pct(groupLevel)}` : "Off"}</b></div>
        </div>
        ${rows || `<div class="sub pad">No lights in this group. ${this._admin ? "Use Edit to add some." : ""}</div>`}
      </section>`;
  }

  _scenesCard(master) {
    const scenes = master.scenes || [];
    const title = this._data.masters.length > 1 ? `<h2 class="master-title">${esc(master.name)}</h2>` : "";
    if (!master.scenes_supported) {
      return `<div class="master-block">${title}<section class="card"><div class="card-head"><ha-icon class="head-icon" icon="mdi:palette-outline"></ha-icon>
        <div class="grow"><h2>Scenes</h2><div class="sub">${esc(master.name)} · Its software has no scenes yet: update it under Settings → Updates.</div></div></div></section></div>`;
    }
    const intro = scenes.length
      ? ""
      : `<section class="card"><div class="card-head"><ha-icon class="head-icon" icon="mdi:palette-outline"></ha-icon>
          <div class="grow"><h2>Scenes</h2><div class="sub">${esc(master.name)} · Lights and groups set together with one tap, on every XP-Mini at once, also without Home Assistant.</div></div></div>
          <div class="sub pad">No scenes yet.</div></section>`;
    const add = this._admin
      ? `<div class="actions"><button class="btn" data-action="new-scene" data-entry="${master.entry_id}">New scene</button></div>`
      : "";
    return `<div class="master-block">${title}${intro}${scenes.map((s) => this._sceneCard(master, s)).join("")}${add}${this._buttonsCard(master)}</div>`;
  }

  // --- buttons (X-Pack inputs) ---------------------------------------------------------------
  // An input keeps its action on the X-Pack: it works with no XP-Master and no Home Assistant.
  // A scene needs no button; a button is one way to trigger it (a schedule may be another).

  _packName(pack) {
    return pack.name || `X-Pack ${pack.uid.slice(-4)}`;
  }

  _buttonsCard(master) {
    const packs = master.packs || [];
    if (!packs.length) return "";
    // One block per X-Pack, its inputs under it: as many as it reports (4 on an X-Pack-RS).
    const blocks = packs.map((pack) => `<div class="pack">
      <div class="pack-head"><ha-icon icon="mdi:light-switch"></ha-icon>
        <div class="grow"><h4>${esc(this._packName(pack))}</h4>
          <div class="light-sub">${pack.inputs.length} input${pack.inputs.length === 1 ? "" : "s"} · firmware ${esc(pack.firmware)}${pack.online ? "" : " · offline"}</div></div></div>
      ${pack.inputs.map((i) => {
        const toggle = i.mode === "toggle";
        const what = toggle
          ? `${this._actionText(master, i.action)} · off: ${this._actionText(master, i.action_off)}`
          : this._actionText(master, i.action);
        const edit = this._admin && pack.online
          ? `<button class="btn secondary" data-action="edit-input" data-entry="${master.entry_id}" data-uid="${esc(pack.uid)}" data-input="${i.input}">Edit</button>`
          : "";
        return `<div class="scene-entry input-row"><ha-icon icon="${toggle ? "mdi:toggle-switch-outline" : "mdi:gesture-tap-button"}"></ha-icon>
          <div class="gr-name"><div class="light-name">${esc(i.name || `Input ${i.input}`)}</div>
            <div class="light-sub">Input ${i.input} · ${toggle ? "Switch" : "Push button"}</div></div>
          <div class="gr-pct">${esc(what)}</div>${edit}</div>`;
      }).join("")}</div>`).join("");
    return `<section class="card buttons-card">
      <div class="card-head"><ha-icon class="head-icon" icon="mdi:gesture-tap-button"></ha-icon>
        <div class="grow"><h2>Buttons</h2><div class="sub">What each X-Pack button or switch does. Kept on the X-Pack: it works without Home Assistant.</div></div></div>
      <div class="packs">${blocks}</div></section>`;
  }

  /** "Scene Evening", "Scene Evening on / off", "Kitchen ceiling on / off", "nothing". */
  _actionText(master, a) {
    if (!a || a.kind === "none") return "nothing";
    let text;
    const atLevel = a.brightness ? ` at ${Math.round((a.brightness / 255) * 100)} %` : "";
    if (a.kind.startsWith("scene")) {
      text = `Scene ${master.scenes.find((sc) => sc.id === a.scene_id)?.name || `${a.scene_id} (deleted)`}`;
      text += { scene: "", scene_toggle: " on / off", scene_off: " off" }[a.kind] ?? "";
    } else if (a.kind.startsWith("port")) {
      const light = master.lights.find((l) => l.id === a.light_id);
      const how = { port_on: "on", port_off: "off", port_toggle: "on / off" }[a.kind] + atLevel;
      text = `${light ? light.name || light.default_name : "A port (gone)"} ${how}`;
    } else {
      const group = master.groups.find((g) => g.id === a.group_id)?.name || `${a.group_id} (deleted)`;
      const how = { group_on: "on", group_off: "off", group_toggle: "on / off" }[a.kind] + atLevel;
      text = `${group} ${how}`;
    }
    return a.transition == null ? text : `${text} · ${+a.transition.toFixed(3)} s`;
  }

  _actionValue(a) {
    if (!a || a.kind === "none") return "none";
    if (a.kind.startsWith("port")) return `${a.kind}:${a.light_id}`;
    return a.kind.startsWith("scene") ? `${a.kind}:${a.scene_id}` : `${a.kind}:${a.group_id}`;
  }

  /** From a select's value; brightness and transition carry over. */
  _actionFromValue(value, was) {
    if (value === "none") return { kind: "none" };
    const [kind, id] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
    const out = { kind, transition: was?.transition ?? null };
    if (kind.startsWith("scene")) out.scene_id = id;
    else if (kind.startsWith("port")) out.light_id = id;
    else out.group_id = id;
    if (ACTION_LEVEL_KINDS.includes(kind) && was?.brightness) out.brightness = was.brightness;
    return out;
  }

  _actionField(master, d, which, label) {
    const a = d[which];
    const value = this._actionValue(a);
    const lock = this._busy ? "disabled" : "";
    const opt = (v, text) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(text)}</option>`;
    // A scene: recalled at each press, or recalled and switched off in turn (kept on the X-Pack).
    const scenes = master.scenes.map((sc) => `${opt(`scene:${sc.id}`, `${sc.name}: on`)}${opt(`scene_toggle:${sc.id}`, `${sc.name}: on / off`)}`)
      .join("");
    const groups = master.groups.map((g) => `<optgroup label="${esc(g.name)}">
        ${opt(`group_toggle:${g.id}`, `${g.name}: on / off`)}${opt(`group_on:${g.id}`, `${g.name}: on`)}
        ${opt(`group_off:${g.id}`, `${g.name}: off`)}</optgroup>`).join("");
    // A port alone: on its XP-Mini, without Home Assistant, as a wall switch of that port.
    const ports = master.lights.map((l) => {
      const name = `${this._miniName(master, l.mini_uid)} · ${l.name || l.default_name}`;
      return `<optgroup label="${esc(name)}">
        ${opt(`port_toggle:${l.id}`, `${name}: on / off`)}${opt(`port_on:${l.id}`, `${name}: on`)}
        ${opt(`port_off:${l.id}`, `${name}: off`)}</optgroup>`;
    }).join("");
    const level = ACTION_LEVEL_KINDS.includes(a.kind)
      ? `<label class="field"><span>Level</span><span class="sub seconds"><input id="in-${which}-level" type="number" min="1" max="100"
          placeholder="—" value="${a.brightness ? Math.round((a.brightness / 255) * 100) : ""}" ${lock}>
          % (empty: only switches)</span></label>` : "";
    const transition = a.kind === "none" ? "" : `<label class="field"><span>Transition</span><span class="sub seconds">
        <input id="in-${which}-tr" type="number" min="0" max="25.4" step="0.1" placeholder="—" value="${a.transition ?? ""}" ${lock}>
        seconds (empty: ${a.kind.startsWith("scene") ? "the scene's own" : "each port's own"})</span></label>`;
    return `<label class="field"><span>${label}</span>
        <select data-action="input-${which === "action" ? "action" : "action-off"}" ${lock}>
          ${opt("none", "Nothing")}
          ${scenes ? `<optgroup label="Scenes">${scenes}</optgroup>` : ""}${groups}${ports}
        </select></label>${level}${transition}`;
  }

  /** The action as set in the dialog; an error text if a value is out of range. */
  _readAction(d, which) {
    const a = { ...d[which] };
    if (a.kind === "none") return { kind: "none" };
    delete a.brightness;
    const lvl = this.shadowRoot.getElementById(`in-${which}-level`)?.value ?? "";
    if (lvl !== "") {
      const pct = Number(lvl);
      if (!(pct >= 1 && pct <= 100)) return "The level is 1 to 100 %";
      a.brightness = Math.max(1, Math.round((pct / 100) * 255));
    }
    const tr = this.shadowRoot.getElementById(`in-${which}-tr`)?.value ?? "";
    if (tr === "") a.transition = null;
    else if (!(Number(tr) >= 0 && Number(tr) <= 25.4)) return "A button's transition is 0 to 25.4 seconds";
    else a.transition = Number(tr);
    return a;
  }

  async _saveInput() {
    const d = this._dialog;
    const msg = { type: "netroni/pack_set_input", entry_id: d.entry, uid: d.uid, input: d.input, mode: d.mode,
      name: (this.shadowRoot.getElementById("input-name")?.value || "").trim() };
    for (const which of d.mode === "toggle" ? ["action", "action_off"] : ["action"]) {
      const a = this._readAction(d, which);
      if (typeof a === "string") {
        this._toast(a);
        return;
      }
      msg[which] = a;
    }
    await this._run(() => this._call(msg));
  }

  /** The strip's range as colours, as Home Assistant's own colour temperature slider shows them. */
  _cctGradient(warm, cool) {
    const stops = [0, 0.25, 0.5, 0.75, 1].map((at) => kelvinRgb(warm + (cool - warm) * at));
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }

  /** A scene's transitions: "start 3 s · end 0.5 s", the one it has, or none. */
  _transitionText(start, end) {
    const text = (label, ms) => (ms ? [`${label} ${+(ms / 1000).toFixed(3)} s`] : []);
    return [...text("start", start), ...text("end", end)].join(" · ") || "no transition";
  }

  _sceneCard(master, scene) {
    const pct = (v) => `${Math.round((v / 255) * 100)} %`;
    const lights = scene.entries.filter((e) => e.light).length;
    const groups = scene.entries.length - lights;
    const parts = [lights ? `${lights} light${lights === 1 ? "" : "s"}` : "", groups ? `${groups} group${groups === 1 ? "" : "s"}` : ""]
      .filter(Boolean).join(", ") || "empty";
    const rows = scene.entries
      .map((e) => {
        const item = e.group ? master.groups.find((g) => g.id === e.group) : master.lights.find((l) => l.id === e.light);
        const name = e.group ? `${item?.name || e.group}` : item ? item.name || item.default_name : e.light;
        const sub = e.group ? "Group" : item ? `${this._miniName(master, item.mini_uid)} · ${item.key.replace("port", "").toUpperCase()}` : "";
        const what = e.on ? `On · <b>${pct(e.brightness ?? 255)}</b>${e.kelvin ? ` · ${e.kelvin} K` : ""}` : "Off";
        return `<div class="scene-entry"><ha-icon icon="${e.group ? "mdi:lightbulb-group-outline" : "mdi:lightbulb-outline"}"></ha-icon>
          <div class="gr-name"><div class="light-name">${esc(name)}</div><div class="light-sub">${esc(sub)}</div></div>
          <div class="gr-pct">${what}</div></div>`;
      })
      .join("");
    const edit = this._admin
      ? `<button class="btn secondary" data-action="edit-scene" data-entry="${master.entry_id}" data-scene="${esc(scene.id)}">Edit</button>`
      : "";
    // What triggers it: buttons for now (optional: a scene needs none).
    const triggers = (master.packs || []).flatMap((p) => p.inputs
      .filter((i) => [i.action, i.mode === "toggle" ? i.action_off : null].some((a) => a?.kind?.startsWith("scene") && a.scene_id === scene.id))
      .map((i) => i.name || `${this._packName(p)} input ${i.input}`));
    const trigger = triggers.length ? ` · Button${triggers.length > 1 ? "s" : ""}: ${esc(triggers.join(", "))}` : "";
    return `
      <section class="card scene-card ${this._gotoScene === `${master.entry_id}|${scene.id}` ? "target" : ""}" id="scene-${master.entry_id}-${esc(scene.id)}">
        <div class="card-head">
          <ha-icon class="head-icon" icon="mdi:palette-outline"></ha-icon>
          <div class="grow"><h3>${esc(scene.name)}</h3>
            <div class="sub">Scene · ${parts} · ${this._transitionText(scene.transition, scene.transition_end)}${trigger}</div></div>
          <button class="btn" data-action="recall-scene" data-entity="${esc(scene.entity_id || "")}" ${scene.entity_id && master.connected ? "" : "disabled"}>Recall</button>
          ${edit}
        </div>
        ${rows ? `<div class="scene-entries">${rows}</div>` : `<div class="sub pad">Nothing in this scene. ${this._admin ? "Use Edit to add lights or groups." : ""}</div>`}
      </section>`;
  }

  /** A scene entry from how the light or group is now (its Home Assistant state). */
  _sceneEntryNow(master, key) {
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const item = kind === "group" ? master.groups.find((g) => g.id === id) : master.lights.find((l) => l.id === id);
    const st = item ? this._hass.states[item.entity_id] : null;
    const entry = { [kind]: id, on: st?.state === "on", brightness: Math.max(1, Number(st?.attributes.brightness) || 255) };
    if (kind === "light" && item?.kind === "tunable_white") {
      const mid = Math.round(((item.min_kelvin || 2200) + (item.max_kelvin || 5000)) / 2 / 50) * 50;
      entry.kelvin = Number(st?.attributes.color_temp_kelvin) || mid;
    }
    return entry;
  }

  _remoteCard(master) {
    const status = this._remote[master.entry_id];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.error) body = this._banner("error", "mdi:alert-circle-outline", esc(status.error));
    else body = this._remoteBody(master, status);
    return `
      <section class="card">
        <div class="card-head">
          <ha-icon class="head-icon" icon="mdi:home-import-outline"></ha-icon>
          <div class="grow">
            <h2>Remote Access</h2>
            <div class="sub">${esc(master.name)} · Other Home Assistants and the Netroni app on your network can control this XP-Master.</div>
          </div>
        </div>
        ${body}
      </section>`;
  }

  _remoteBody(master, status) {
    const entry = master.entry_id;
    const when = (t) => (t ? new Date(t * 1000).toLocaleString() : "never");
    const renewing = status.key_rotation; // the keys are being renewed (docs/key-rotation.md in xp-master)
    const hasNew = (c) => renewing && (renewing.confirmed || []).includes(c.id);
    const keys = (c) => (renewing ? ` · ${hasNew(c) ? "has the new keys" : "doesn't have the new keys yet"}` : "");
    const clients = (status.clients || []).map(
      (c) => `<div class="app"><ha-icon icon="mdi:home-assistant"></ha-icon>
        <div class="grow"><div>${esc(c.name)}</div><div class="sub">Paired ${esc(when(c.created))} · last seen ${esc(when(c.last_seen))}${esc(keys(c))}</div></div>
        ${this._admin ? `<button class="btn secondary" data-action="remote-revoke" data-entry="${entry}" data-client="${esc(c.id)}" data-name="${esc(c.name)}" ${status.busy ? "disabled" : ""}>Remove</button>` : ""}</div>`
    );
    let html = `<h4>Paired Home Assistants and apps</h4>${clients.length ? `<div class="apps">${clients.join("")}</div>` : `<div class="sub pad">None yet.</div>`}`;
    // As on the XP-Master's display while pairing: name, serial, address.
    const shown = [master.name, master.master_id, status.address].filter(Boolean).map((p) => `<b>${esc(p)}</b>`).join(" · ");
    if (status.pairing && status.pairing.code) {
      const code = `${status.pairing.code.slice(0, 3)} ${status.pairing.code.slice(3)}`;
      html += `
        <div class="qr-box">
          <div class="grow">
            <h4>Pair a Home Assistant or app</h4>
            <p>In the other Home Assistant, add the <b>Netroni XP-Master</b> integration (it may already be offered under Discovered); in the Netroni app, tap the XP-Master. Then enter this code:</p>
            <p><b class="code">${esc(code)}</b></p>
            <div class="sub" id="remote-countdown-${entry}">The code works for 5 minutes.</div>
            <p class="sub">It is also on the XP-Master's display, with ${shown}. Check that the other Home Assistant or the app shows the same XP-Master.</p>
            <div class="actions"><button class="btn secondary" data-action="remote-cancel" data-entry="${entry}" ${status.busy ? "disabled" : ""}>Cancel</button></div>
          </div>
        </div>`;
    } else if (status.pairing) {
      html += `<div class="sub pad">A pairing window is open.</div>`;
    } else if (this._admin) {
      html += `<div class="actions"><button class="btn" data-action="remote-pair" data-entry="${entry}" ${status.busy ? "disabled" : ""}>
        ${status.busy ? "Opening…" : "Pair a Home Assistant or app"}</button></div>`;
    } else {
      html += `<div class="sub pad">An administrator can pair a Home Assistant or app.</div>`;
    }
    html += this._remoteKeys(entry, status);
    html += `<p class="sub pad">The XP-Master only accepts remote connections while a Home Assistant or app is paired or a pairing window is open. The connection is encrypted; each has its own key and can be removed here.</p>`;
    return html;
  }

  // Renewing the keys that protect remote connections: the paired ones take them, no pairing again.
  _remoteKeys(entry, status) {
    const renewing = status.key_rotation;
    const busy = status.busy ? "disabled" : "";
    if (!renewing) {
      return `<h4>Keys</h4>
        <p class="sub pad">The keys that protect remote connections are renewed by the XP-Master before they run out. The paired Home Assistants and apps take the new ones by themselves.</p>
        ${this._admin ? `<div class="actions"><button class="btn secondary" data-action="remote-rotate" data-entry="${entry}" ${busy}>Renew keys</button></div>` : ""}`;
    }
    const clients = status.clients || [];
    const done = clients.filter((c) => (renewing.confirmed || []).includes(c.id)).length;
    const by = new Date(renewing.switch_after * 1000).toLocaleDateString();
    return `<h4>Keys</h4>
      <p class="sub pad">Renewing the keys: ${done} of ${clients.length} have the new ones. The XP-Master switches to them once all have, or on ${esc(by)} at the latest. One that doesn't have them by then has to be paired again.</p>
      ${this._admin ? `<div class="actions"><button class="btn secondary" data-action="remote-switch" data-entry="${entry}" ${busy}>Switch now</button></div>` : ""}`;
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
            <h2>Matter</h2>
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
        <p class="sub">A light is in one group at most: to move one here, remove it from its group first. The group's level scales the lights it switched on or set; each keeps its own brightness.</p>`;
      action = `${d.groupId ? `<button class="btn ${d.confirmDelete ? "danger" : "secondary"}" data-action="delete-group" ${this._busy ? "disabled" : ""}>${d.confirmDelete ? "Delete for good" : "Delete group"}</button>` : ""}
        <button class="btn" data-action="save-group" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "scene") {
      const master = this._master(d.entry);
      title = d.sceneId ? `Edit ${esc(d.name || "scene")}` : "New scene";
      const lock = this._busy ? "disabled" : "";
      const row = (key, name, sub, light) => {
        const e = d.entries[key];
        const set = e
          ? `<div class="scene-set">
              <label class="tw"><input type="checkbox" data-action="scene-on" data-key="${esc(key)}" ${e.on ? "checked" : ""} ${lock}><span class="switch"></span>On</label>
              <input class="slider" type="range" min="1" max="255" value="${e.brightness}" data-action="scene-brightness" data-key="${esc(key)}" ${lock}>
              <span class="scene-pct" data-pct="${esc(key)}">${Math.round((e.brightness / 255) * 100)} %</span>
              ${light?.kind === "tunable_white" ? `<label class="scene-k"><input type="number" min="${light.min_kelvin || 1000}" max="${light.max_kelvin || 10000}" step="50"
                value="${e.kelvin ?? ""}" data-action="scene-kelvin" data-key="${esc(key)}" ${lock}> K</label>` : ""}
            </div>`
          : "";
        return `<div class="scene-row ${e ? "in" : ""}">
          <label class="member"><input type="checkbox" data-action="scene-member" data-key="${esc(key)}" ${e ? "checked" : ""} ${lock}>
            <span>${esc(name)}</span><span class="sub">${esc(sub)}</span></label>${set}</div>`;
      };
      const groups = (master.groups || []).map((g) => row(`group:${g.id}`, g.name, `Group · ${g.members.length} light${g.members.length === 1 ? "" : "s"}`)).join("");
      const lights = master.minis
        .map((mini) => {
          const items = master.lights.filter((l) => l.mini_uid === mini.uid)
            .map((l) => row(`light:${l.id}`, l.name || l.default_name, `${mini.name} · ${l.key.replace("port", "").toUpperCase()}`, l)).join("");
          return items ? `<div class="member-mini">${esc(mini.name)}</div>${items}` : "";
        })
        .join("");
      body = `
        <label class="field"><span>Name</span>
          <input id="scene-name" type="text" value="${esc(d.name)}" placeholder="Evening" ${lock}></label>
        <label class="field"><span>Start transition</span><span class="sub seconds">
          <input id="scene-start" type="number" min="0" max="600" step="0.1" placeholder="—" value="${esc(String(d.transition))}" ${lock}>
          seconds, coming on when recalled (empty: none)</span></label>
        <label class="field"><span>End transition</span><span class="sub seconds">
          <input id="scene-end" type="number" min="0" max="600" step="0.1" placeholder="—" value="${esc(String(d.transitionEnd))}" ${lock}>
          seconds, going off (empty: none)</span></label>
        <div class="members-block"><div class="members-label">What it sets</div><div class="members scene-members">
          ${groups ? `<div class="member-mini">Groups</div>${groups}` : ""}${lights}</div></div>
        <div class="actions left"><button class="btn secondary" data-action="scene-now" ${Object.keys(d.entries).length && !this._busy ? "" : "disabled"}>Set from the lights as they are now</button></div>
        <p class="sub">Each XP-Mini keeps its part and all of them change at once when the scene is recalled, also without Home Assistant. A light's own setting wins over its group's. A group's brightness is its level: its lights keep their own brightness under it. A light with its own setting gives out exactly that.</p>`;
      action = `${d.sceneId ? `<button class="btn ${d.confirmDelete ? "danger" : "secondary"}" data-action="delete-scene" ${lock}>${d.confirmDelete ? "Delete for good" : "Delete scene"}</button>` : ""}
        <button class="btn" data-action="save-scene" ${lock}>Save</button>`;
    } else if (d.kind === "input") {
      const master = this._master(d.entry);
      const pack = (master?.packs || []).find((p) => p.uid === d.uid) || { uid: d.uid };
      const lock = this._busy ? "disabled" : "";
      const toggle = d.mode === "toggle";
      title = `Input ${d.input} of ${esc(this._packName(pack))}`;
      body = `
        <label class="field"><span>Name</span>
          <input id="input-name" type="text" maxlength="32" value="${esc(d.name)}" placeholder="Input ${d.input}" ${lock}></label>
        <div class="field"><span>Connected</span>
          <label class="choice"><input type="radio" name="input-mode" value="push" ${toggle ? "" : "checked"} ${lock}>
            <span><b>Push button</b><span class="sub">Each press does it.</span></span></label>
          <label class="choice"><input type="radio" name="input-mode" value="toggle" ${toggle ? "checked" : ""} ${lock}>
            <span><b>Switch</b><span class="sub">Turned on does one thing, turned off another.</span></span></label>
        </div>
        ${this._actionField(master, d, "action", toggle ? "When turned on" : "When pressed")}
        ${toggle ? this._actionField(master, d, "action_off", "When turned off") : ""}
        <p class="sub">Kept on the X-Pack: the button works the same without the XP-Master or Home Assistant. "On / off" switches the group the other way at each press.</p>`;
      action = `<button class="btn" data-action="save-input" ${lock}>Save</button>`;
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
        <div class="cct-bar" id="cct-bar" style="background: ${this._cctGradient(d.warm, d.cool)}"></div>
        <div class="cct-labels" id="cct-labels">${this._cctLabels(d.warm, d.cool)}</div>
        <p class="sub">Home Assistant, Matter and the XP-Mini use this range for this light. A colour temperature outside the new range moves to its nearest end.</p>`;
      if (d.follows !== null && d.follows !== undefined) {
        const st = this._circadian[d.entry];
        body += `
        <div class="set-row">
          <div class="grow"><div>Follow circadian lighting</div><div class="sub">The XP-Master changes its colour temperature through the day.
            ${st.enabled ? "" : "Circadian lighting is off: turn it on in Settings."}</div></div>
          <label class="tw"><input type="checkbox" id="cct-circadian" ${d.follows ? "checked" : ""} ${this._busy ? "disabled" : ""}><span class="switch"></span></label>
        </div>`;
      }
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
        ${item("dmx", "mdi:tune-vertical", "DMX…", mini?.online ? `Channels ${dmxRange(mini.dmx_start, mini.dmx_resolution || 8)} at ${mini.dmx_resolution || 8}-bit; change them, or 8 or 16-bit, for a DMX console.` : "Only when it is online.", mini?.online)}
        ${Object.keys(mini?.settings_offered?.dimming_curves || {}).length
          ? item("curve", "mdi:chart-bell-curve-cumulative", "Dimming curve…",
            mini?.online ? `${esc(mini.settings_offered.dimming_curves[String(mini.dimming_curve)] || "")}: how the brightness follows the level, for all its ports.` : "Only when it is online.", mini?.online)
          : ""}
        ${item("reset", "mdi:backup-restore", "Factory reset…", "Forgets everything; found again as a new XP-Mini.", mini?.online, true)}
        ${item("replace", "mdi:swap-horizontal", "Replace…", mini?.online ? "Only when it is offline: a new XP-Mini takes its place." : "A new XP-Mini takes its place.", !mini?.online && spares)}
        ${item("remove", "mdi:delete-outline", "Remove…", mini?.online ? "Only when it is offline (disconnected for good)." : "Forget it: lights, names and DMX block.", !mini?.online, true)}
      </div>`;
    } else if (d.kind === "curve") {
      const mini = this._mini(d.entry, d.uid);
      const curves = mini?.settings_offered?.dimming_curves || {};
      title = `Dimming curve of ${esc(mini?.name || d.uid)}`;
      body = `<div class="field">${Object.entries(curves)
        .map(([id, label]) => `
          <label class="choice"><input type="radio" name="curve" value="${esc(id)}" ${Number(id) === d.curve ? "checked" : ""}>
            <span><b>${esc(label)}</b>${Number(id) === 6 ? `<span class="sub">The default: even steps for the eye.</span>` : ""}</span></label>`)
        .join("")}</div>
        <p class="sub">How the light's brightness follows the level, for all ports of this XP-Mini. Used at once.</p>`;
      action = `<button class="btn" data-action="save-curve" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "universe") {
      const [low, high] = UNIVERSES[d.protocol];
      const name = d.protocol === "sacn" ? "sACN" : "Art-Net";
      title = `${name} universe`;
      body = `<label class="field"><span>Universe (${low}–${high})</span>
          <input id="universe-value" type="number" min="${low}" max="${high}" step="1" value="${esc(d.value)}"></label>
        <p class="sub">The universe this XP-Master ${d.protocol === "sacn" ? "listens to" : "responds as"}: the one set in the console's ${name} output. In use at once.</p>`;
      action = `<button class="btn" data-action="save-universe" ${this._busy ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "dmx") {
      const mini = this._mini(d.entry, d.uid);
      const name = esc(mini?.name || d.uid);
      const now = mini?.dmx_resolution || 8;
      // The resolutions it takes, by its description; all while that isn't known (older XP-Master).
      const takes = mini?.settings_offered?.dmx_resolutions;
      const option = (resolution, text) => {
        const off = takes && !takes.includes(resolution);
        return `
        <label class="choice"><input type="radio" name="dmx-res" value="${resolution}" ${d.resolution === resolution ? "checked" : ""} ${off ? "disabled" : ""}>
          <span><b>${resolution}-bit</b><span class="sub">${off ? "Needs newer XP-Mini firmware" : text}</span></span></label>`;
      };
      const check = this._dmxCheck();
      title = `DMX of ${name}`;
      body = `<p>${name} listens to DMX channels ${mini ? dmxRange(mini.dmx_start, now) : "?"} at ${now}-bit.</p>
        <div class="field"><span>Resolution</span>
          ${option(8, "16 channels, one per output: Port 1A, 1B, 2A …")}
          ${option(16, "32 channels, two per output (coarse, fine), for a 16-bit console")}</div>
        <label class="field"><span>Start channel</span>
          <input id="dmx-start" type="number" inputmode="numeric" min="1" max="${513 - dmxSize(d.resolution)}" value="${d.start ?? ""}"></label>
        <div id="dmx-check" class="sub dmx-check ${check.ok ? "" : "bad-text"}">${d.full ? "No room for a block this size: DMX is full." : check.text}</div>
        <p class="sub">A DMX console patched to the old channels no longer controls it. Its lights, names and groups stay as they are.</p>`;
      action = `<button class="btn" id="dmx-save" data-action="confirm-dmx" ${this._busy || !check.ok || !check.changed ? "disabled" : ""}>Save</button>`;
    } else if (d.kind === "reset") {
      const mini = this._mini(d.entry, d.uid);
      const name = esc(mini?.name || d.uid);
      title = `Reset ${name} to factory settings?`;
      body = `<p>${name} (${esc(d.uid)}) forgets all its settings and its lights go off. The XP-Master forgets it too: it is found again as a new XP-Mini, with default light names, no areas and the first free DMX block.</p>
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
    // Redrawn on every tick or slider change: the dialog and its list stay where they were scrolled.
    const scrolled = [".dialog", ".members"].map((sel) => [sel, host.querySelector(sel)?.scrollTop]);
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
    for (const [sel, top] of scrolled) {
      const el = host.querySelector(sel);
      if (el && top) el.scrollTop = top;
    }
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
  .set-row { display: flex; align-items: center; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); }
  .set-row:first-of-type { border-top: 0; }
  .set-value { font-size: 15px; font-weight: 500; }
  .mqtt-form, .circadian-form { margin-top: 4px; }
  .circadian-form .field-row { flex-wrap: wrap; }
  .circadian-form .field { min-width: 180px; }
  .circadian-form .actions { margin: 16px 0 14px; }
  .circadian-form .link { font: inherit; color: var(--primary-color); background: none; border: 0; padding: 0 0 0 4px; cursor: pointer; }
  .chip-sun { --mdc-icon-size: 15px; vertical-align: -2px; color: var(--warning-color, #f0a400); }
  .mqtt-form .field-row { flex-wrap: wrap; }
  .mqtt-form .field { min-width: 220px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 20px; overflow: hidden; flex: none; }
  .seg-btn { font: inherit; font-size: 14px; border: 0; background: none; color: var(--primary-text-color); padding: 7px 16px; cursor: pointer; }
  .seg-btn + .seg-btn { border-left: 1px solid var(--line); }
  .seg-btn.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .seg-btn:disabled { cursor: default; opacity: .7; }
  .fact-label { font-size: 12px; color: var(--secondary-text-color); }
  .fact-value { font-size: 14px; margin-top: 2px; }
  .fact-link { color: var(--primary-color); cursor: pointer; text-decoration: none; }
  .fact-link:hover { text-decoration: underline; }
  .banner { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 14px; border-radius: 10px; line-height: 1.4; }
  .banner.warn { background: rgba(255, 166, 0, .14); }
  .banner.warn > ha-icon { color: var(--warn); }
  .banner.info { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
  .banner.info > ha-icon { color: var(--primary-color); }
  .banner.error { background: rgba(219, 68, 55, .12); }
  .banner.error > ha-icon { color: var(--bad); }
  /* 8 ports in even rows: 4 + 4 where the card is wide enough, else 2 per row, or 1 on a phone; never 3 or 5.
     The card's own width decides (a container), so the sidebar open or closed doesn't matter. */
  .card.mini { container-type: inline-size; }
  .ports { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
  @container (max-width: 880px) { .ports { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @container (max-width: 440px) { .ports { grid-template-columns: minmax(0, 1fr); } }
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
  .scene-entries { margin-top: 10px; }
  .scene-entry.input-row { grid-template-columns: 28px minmax(0, 1fr) auto auto; }
  .scene-entry { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 8px 0;
    border-top: 1px solid var(--line); }
  .scene-entry ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); justify-self: center; }
  .scene-row { border-top: 1px solid var(--line); }
  .scene-row:first-child, .member-mini + .scene-row { border-top: 0; }
  .scene-row .member { padding: 6px 0; }
  .scene-set { display: flex; align-items: center; gap: 12px; padding: 0 0 8px 21px; }
  .scene-set .slider { flex: 1; min-width: 0; }
  .scene-set .tw { margin-top: 0; flex: none; }
  .scene-pct { flex: none; width: 40px; text-align: right; font-size: 13px; color: var(--secondary-text-color); }
  .scene-k { flex: none; display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--secondary-text-color); }
  .scene-k input { width: 64px; font: inherit; padding: 4px 6px; border-radius: 6px; border: 1px solid var(--line);
    background: var(--input-fill-color, var(--secondary-background-color)); color: var(--primary-text-color); }
  .scene-members { max-height: 380px; }
  .field .choice .seconds { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: 13px; }
  .field .choice .seconds input { width: 72px; padding: 6px 8px; flex: none; margin: 0; }
  .field > .seconds { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .field > .seconds input { width: 96px; flex: none; margin: 0; }
  .actions.left { justify-content: flex-start; }
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
  .grow-row.group-level { border-top: 0; margin-top: 8px; }
  .grow-row.on .lamp { color: var(--lamp-on); background: rgba(255, 152, 0, .16); }
  .grow-row.partly .lamp { color: var(--lamp-on); box-shadow: inset 0 0 0 1.5px var(--lamp-on); background: transparent; }
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
  .group-chip + .group-chip { margin-left: 4px; }
  .group-chip:hover { background: rgba(0, 150, 136, .18); }
  .group-icon { color: #00897b; }
  .group-card { transition: box-shadow .4s, border-color .4s; }
  .group-card.target, .scene-card.target { border-color: #00897b; box-shadow: 0 0 0 3px rgba(0, 150, 136, .25); }
  .hide-row { margin-top: 16px; color: var(--primary-text-color); font-size: 14px; }
  .hide-note { margin-top: 4px; }
  .member.taken { cursor: default; color: var(--disabled-text-color, #9e9e9e); }
  .member .sub { margin-left: auto; font-size: 12px; }
  @media (max-width: 600px) { .grow-row { grid-template-columns: 34px 1fr 90px; } .grow-row .slider { grid-column: 1 / -1; } }
  .cct-bar { height: 14px; border-radius: 7px; margin-top: 16px; border: 1px solid var(--line); }
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
  .choice { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; cursor: pointer; }
  .field .choice input { width: auto; margin: 3px 0 0; padding: 0; flex: none; accent-color: var(--primary-color); }
  .choice .sub { display: block; }
  .dmx-check { margin-top: 6px; min-height: 1.4em; }
  .bad-text { color: var(--bad); }
  .chevron { margin: 0 -8px 0 -8px; }
  .settings-fold { border-top: 1px solid var(--line); margin-top: 8px; }
  .fold-head { display: flex; align-items: center; gap: 10px; padding: 14px 0; }
  .fold-head:hover .fold-title { color: var(--primary-color); }
  .fold-chevron { --mdc-icon-size: 22px; color: var(--secondary-text-color); margin-left: -4px; }
  .fold-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
  .fold-title { font-size: 16px; font-weight: 500; }
  .fold-body { padding: 0 0 8px 32px; }
  .sub-card { border: 1px solid var(--line); border-radius: 12px; padding: 2px 16px 6px; margin: 0 0 12px;
    background: rgba(127, 127, 127, .05); }
  .sub-card h4 { font-size: 16px; margin: 12px 0 2px; }
  .sub-card h4 + .set-row, .sub-card h4 + div > .set-row:first-child { border-top: 0; }
  .fold { cursor: pointer; user-select: none; }
  .summary { margin-top: 12px; }
  .summary b { color: var(--primary-text-color); font-weight: 500; }
  .summary.link { display: block; font: inherit; font-size: 13px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
  .summary.link:hover { text-decoration: underline; }
  .fold-bar { display: flex; justify-content: flex-end; gap: 4px; margin: -8px 0 8px; }
  .btn.small { padding: 6px 12px; font-size: 13px; }
  .btn:disabled { opacity: .5; cursor: default; }
  .actions { margin-top: 12px; }
  .buttons-card { margin-top: 32px; }
  .packs { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }
  .pack { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px 2px; }
  .pack-head { display: flex; align-items: center; gap: 12px; padding: 4px 0 8px; }
  .pack-head ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); width: 28px; text-align: center; }
  .pack-head h4 { margin: 0; } /* its own section, below the scenes and their New scene */
  .master-block + .master-block { margin-top: 40px; }
  .master-title { margin: 0 0 12px 4px; }
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
  .dmx-grid { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(16, 1fr); grid-auto-rows: var(--dmx-row); gap: 2px; }
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
    .dmx-labels { width: 32px; }
    .dmx-label span { display: none; }
    .ports { grid-template-columns: 1fr 1fr; }
    .facts { gap: 8px 20px; }
  }
  @media (max-width: 420px) { .ports { grid-template-columns: 1fr; } }
`;

// A page that loaded an older version keeps that one until it is reloaded.
if (!customElements.get("netroni-panel")) customElements.define("netroni-panel", NetroniPanel);
