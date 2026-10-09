// Custom icon set "netroni": the Netroni logo (the N and its three bars) for the sidebar entry.
// Paths from assets/netroni_icon.svg; drawn in the current icon colour like any other icon.
const NETRONI_LOGO =
  "M57.1,65.3c-1.7-1.7-4.8-0.3-4.8,2v161.1c0,1.7-1.4,3.1-3.1,3.1H3.1c-1.7,0-3.1-1.4-3.1-3.1V26.2" +
  "C0,11.9,11.6,0.3,25.8,0.3h6.8c12.2,0,24.1,4.8,33.3,13.3L226,166.2c1.7,1.7,4.8,0.3,4.8-2V3.1c0-1.7,1.4-3.1,3.1-3.1h46.6" +
  "c1.7,0,3.1,1.4,3.1,3.1v202.2c0,14.3-11.6,25.8-25.8,25.8h-7.1c-12.2,0-24.1-4.8-33.3-13.3L57.1,65.3z" +
  "M0,260.1h97.4v11.2H0z M104.5,260.1h75.5v11.2h-75.5z M186.1,260.1h97.4v11.2h-97.4z";

const ICONS = { logo: { path: NETRONI_LOGO, viewBox: "0 -6.1 283.5 283.5" } };

window.customIcons = window.customIcons || {};
window.customIcons.netroni = {
  getIcon: async (name) => ICONS[name],
  getIconList: async () => Object.keys(ICONS).map((name) => ({ name })),
};
