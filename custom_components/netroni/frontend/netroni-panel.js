// Netroni sidebar panel: installation overview and commissioning.
//
// A plain web component (no build step). Home Assistant sets `hass` and `narrow`; the structure
// comes from the integration's "netroni/subscribe" WebSocket subscription and live light states
// from hass.states. Everyone can look and use Identify; changes need an administrator (the
// WebSocket commands enforce it, the panel only hides the controls).

const HIGHLIGHT_MS = 60_000; // how long a port that identified itself stays highlighted
const MATTER_POLL_S = 10;

const APP_ICONS = {
  SmartThings: "mdi:hub-outline",
  "Google Home": "mdi:google-home",
  "Amazon Alexa": "mdi:amazon-alexa",
  "Apple Home": "mdi:apple",
  "Home Assistant": "mdi:home-assistant",
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
    this._busy = false;
    this._stateSig = "";
    this._ticks = 0;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div id="main"></div><div id="dialog"></div>`;
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
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
    if (this._hass && !this._unsub) this._subscribe();
    this._timer = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
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
        ${this._tabButton("matter", "Matter Connections")}
      </div>
      <div class="content"><div class="inner">${this._body()}</div></div>`;
    if (scroll) this.shadowRoot.querySelector(".content").scrollTop = scroll;
    if (this._tab === "matter") this._updateCountdowns();
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
    return this._tab === "matter"
      ? this._data.masters.map((m) => this._matterCard(m)).join("")
      : this._data.masters.map((m) => this._installation(m)).join("");
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
            <div class="sub">XP-Master · ${esc(master.master_id)}</div>
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
    const offline = !mini.online
      ? this._banner(
          "warn",
          "mdi:lan-disconnect",
          `<b>${esc(mini.name)} is offline.</b> It no longer answers so its lights can't be controlled. Check its cable and power supply.`,
          this._admin
            ? `<button class="btn danger" data-action="remove" data-entry="${master.entry_id}" data-uid="${esc(mini.uid)}">Remove XP-Mini</button>`
            : ""
        )
      : "";
    return `
      <section class="card mini ${mini.online ? "" : "offline"}">
        <div class="card-head">
          <ha-icon class="head-icon mini-icon" icon="netroni:xp-mini"></ha-icon>
          <div class="grow">
            <h3>${esc(mini.name)}</h3>
            <div class="sub">XP-Mini · ${esc(mini.uid)}${mini.area ? ` · ${esc(mini.area)}` : ""}</div>
          </div>
          ${this._chip(mini.online, "Online", "Offline")}
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
        <label class="tw ${this._admin ? "" : "readonly"}" title="${this._admin ? "One light: A warm white, B cool white" : "Only an administrator can change this"}">
          <input type="checkbox" data-action="tw" ${data} ${tw ? "checked" : ""} ${this._admin ? "" : "disabled"}>
          <span class="switch"></span>Tunable white
        </label>
      </div>`;
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
        </div>
        ${edit}
      </div>`;
  }

  _matterCard(master) {
    const status = this._matter[master.entry_id];
    let body;
    if (!status) body = `<div class="empty small">Loading…</div>`;
    else if (status.error) body = this._banner("error", "mdi:alert-circle-outline", esc(status.error));
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
    }
    host.innerHTML = `
      <div class="scrim" data-action="scrim">
        <div class="dialog" role="dialog" aria-modal="true">
          <div class="dialog-head"><h2>${title}</h2>
            <button class="icon-btn" data-action="close-dialog" title="Close"><ha-icon icon="mdi:close"></ha-icon></button></div>
          ${body}
          <div class="dialog-actions">
            <button class="btn secondary" data-action="close-dialog">Cancel</button>${action}
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
  @media (max-width: 600px) {
    .inner { padding: 12px; }
    .ports { grid-template-columns: 1fr 1fr; }
    .facts { gap: 8px 20px; }
  }
  @media (max-width: 420px) { .ports { grid-template-columns: 1fr; } }
`;

customElements.define("netroni-panel", NetroniPanel);
