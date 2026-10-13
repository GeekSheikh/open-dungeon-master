// The table's own arrangement (client issue 46): a saved layout reads back
// as itself or as the default, never as something half-broken; every edit
// keeps the table docked, the portraits and the side panel present and the
// limits held; and the pixels it lays out stay inside the row whatever the
// window does, with the table never squeezed under its floor.
import assert from "node:assert/strict";
import {
  defaultTableLayout,
  dockFloating,
  dockPane,
  floatPane,
  hiddenPanes,
  isDefaultShape,
  isPaneHidden,
  locatePane,
  MAX_COLUMNS,
  MAX_STACK,
  MIN_PANE_HEIGHT,
  MIN_TABLE,
  moveFloating,
  normalizeTableLayout,
  PANEL_WIDE,
  PANEL_WIDTH,
  panelWidth,
  popOutTab,
  poppedTabs,
  RAIL_WIDTH,
  raiseFloating,
  returnTab,
  setChronicle,
  setLocked,
  setPaneHidden,
  setPanelWidth,
  stepPane,
} from "../src/lib/table-layout.ts";
import { applySplit, dropRect, dropTarget, tableGeometry } from "../src/lib/table-layout-geometry.ts";

let passed = 0;
function test(name, fn) {
  try {
    fn();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
  passed += 1;
}

const ids = (layout) => layout.columns.map((column) => column.panes.map((pane) => pane.id));
const all = () => true;
const roundTrip = (layout) => normalizeTableLayout(JSON.parse(JSON.stringify(layout)));
const inside = (geometry) => {
  for (const pane of [...geometry.docked, ...geometry.floating]) {
    const { x, y, w, h } = pane.rect;
    assert.ok(x >= 0 && y >= 0 && w >= 0 && h >= 0, `${pane.id} has a negative edge`);
    assert.ok(x + w <= geometry.width + 0.5, `${pane.id} runs past the right edge`);
    assert.ok(y + h <= geometry.height + 0.5, `${pane.id} runs past the bottom`);
  }
};

test("the default is the table's own: portraits, table, side panel, the panel at 24rem or 30rem", () => {
  const layout = defaultTableLayout();
  assert.deepEqual(ids(layout), [["rail"], ["table"], ["panel"]]);
  assert.equal(layout.columns[0].width, RAIL_WIDTH);
  assert.equal(layout.columns[1].width, null);
  assert.equal(panelWidth(layout), PANEL_WIDTH);
  assert.equal(panelWidth(defaultTableLayout(true)), PANEL_WIDE);
  assert.ok(isDefaultShape(layout));
  assert.equal(layout.locked, false);
  assert.deepEqual(roundTrip(layout), layout);
});

test("anything that is not a saved layout of this version reads as the default", () => {
  const fallback = defaultTableLayout();
  for (const raw of [null, undefined, 7, "layout", [], {}, { version: 2, columns: [] }, { version: 1 }, { version: 1, columns: "x" }]) {
    assert.deepEqual(normalizeTableLayout(raw), fallback);
  }
  // No table, or no portraits, or no side panel: the default again.
  assert.deepEqual(normalizeTableLayout({ version: 1, columns: [{ width: 300, panes: [{ id: "panel", size: 1 }, { id: "rail", size: 1 }] }] }), fallback);
  assert.deepEqual(normalizeTableLayout({ version: 1, columns: [{ width: null, panes: [{ id: "table", size: 1 }] }] }), fallback);
  // The fallback given is the one used (the widened panel of an older browser).
  assert.equal(panelWidth(normalizeTableLayout(null, defaultTableLayout(true))), PANEL_WIDE);
});

test("a saved layout is repaired: unknown and repeated panes dropped, sizes and widths in range, the table's column flexible", () => {
  const layout = normalizeTableLayout({
    version: 1,
    locked: true,
    chronicle: 99999,
    columns: [
      { width: 20, panes: [{ id: "rail", size: -3, hidden: false }, { id: "tab:nope", size: 1 }, { id: "rail", size: 1 }] },
      { width: 500, panes: [{ id: "table", size: 2, hidden: true }, { id: "tab:notes", size: 6 }] },
      { width: "wide", panes: [{ id: "panel", size: 1 }] },
      { width: 300, panes: [] },
    ],
    floating: [
      { id: "table", x: 0, y: 0, w: 0.5, h: 0.5 },
      { id: "tab:map", x: 0.9, y: -1, w: 3, h: 0.5, hidden: true },
      { id: "tab:story", x: "a", y: 0, w: 0.5, h: 0.5 },
    ],
  });
  assert.deepEqual(ids(layout), [["rail"], ["table", "tab:notes"], ["panel"]]);
  assert.equal(layout.locked, true);
  assert.equal(layout.columns[0].width, 200, "a width under the floor is raised to it");
  assert.equal(layout.columns[1].width, null, "the table's column takes the rest");
  assert.equal(layout.columns[2].width, 340, "an unreadable width is a new column's");
  assert.equal(layout.columns[0].panes[0].hidden, false, "the portraits keep an explicit shown");
  assert.equal(layout.columns[1].panes[0].hidden, undefined, "the table is never hidden");
  const [table, notes] = layout.columns[1].panes;
  assert.ok(Math.abs(table.size - 0.25) < 1e-9 && Math.abs(notes.size - 0.75) < 1e-9, "shares add up to one");
  assert.deepEqual(layout.floating, [{ id: "tab:map", x: 0, y: 0, w: 1, h: 0.5, hidden: true }]);
  assert.equal(layout.chronicle, 720);
  assert.ok(!isDefaultShape(layout));
});

test("limits hold on read: four columns, four panes in a column, four afloat", () => {
  const columns = [
    { width: null, panes: [{ id: "table", size: 1 }] },
    { width: 300, panes: ["rail", "panel", "tab:notes", "tab:map", "tab:story"].map((id) => ({ id, size: 1 })) },
    ...["tab:chat", "tab:party", "tab:settings", "tab:dm"].map((id) => ({ width: 300, panes: [{ id, size: 1 }] })),
  ];
  const layout = normalizeTableLayout({ version: 1, columns, floating: [] });
  assert.equal(layout.columns.length, MAX_COLUMNS);
  assert.equal(layout.columns[1].panes.length, MAX_STACK);
  assert.ok(!locatePane(layout, "tab:story"));
});

test("docking above, below, beside, at either end, and swapping", () => {
  const start = defaultTableLayout();
  const below = dockPane(start, "rail", { pane: "panel", edge: "bottom" });
  assert.deepEqual(ids(below), [["table"], ["panel", "rail"]], "the portraits' column closes when they leave it");
  assert.equal(below.columns[0].width, null);
  const above = dockPane(start, "rail", { pane: "panel", edge: "top" });
  assert.deepEqual(ids(above), [["table"], ["rail", "panel"]]);
  const right = dockPane(start, "rail", { pane: "panel", edge: "right" });
  assert.deepEqual(ids(right), [["table"], ["panel"], ["rail"]]);
  assert.equal(right.columns[2].width, RAIL_WIDTH, "a pane alone in its column keeps that column's width");
  const start2 = dockPane(start, "panel", { edge: "start" });
  assert.deepEqual(ids(start2), [["panel"], ["rail"], ["table"]]);
  const swapped = dockPane(start, "rail", { pane: "panel", edge: "center" });
  assert.deepEqual(ids(swapped), [["panel"], ["table"], ["rail"]]);
  assert.equal(dockPane(start, "rail", { pane: "rail", edge: "top" }), null, "not against itself");
});

test("the table can move, and wherever it goes its column is the flexible one", () => {
  const moved = dockPane(defaultTableLayout(), "table", { pane: "panel", edge: "top" });
  assert.deepEqual(ids(moved), [["rail"], ["table", "panel"]]);
  assert.equal(moved.columns[1].width, null);
  assert.equal(moved.columns[0].width, RAIL_WIDTH);
  const beside = dockPane(defaultTableLayout(), "table", { edge: "end" });
  assert.deepEqual(ids(beside), [["rail"], ["panel"], ["table"]]);
  assert.equal(beside.columns[2].width, null);
  assert.equal(beside.columns.filter((column) => column.width === null).length, 1);
});

test("a full column or a full row refuses one more", () => {
  let layout = defaultTableLayout();
  for (const tab of ["notes", "map", "story"]) layout = dockPane(popOutTab(layout, tab), `tab:${tab}`, { pane: "panel", edge: "bottom" }) ?? layout;
  assert.equal(layout.columns.find((column) => column.panes.some((pane) => pane.id === "panel")).panes.length, MAX_STACK);
  assert.equal(dockPane(layout, "rail", { pane: "panel", edge: "top" }), null);
  let row = defaultTableLayout();
  row = popOutTab(row, "notes");
  row = dockPane(row, "tab:notes", { edge: "end" });
  assert.equal(row.columns.length, MAX_COLUMNS);
  row = popOutTab(row, "chat");
  assert.equal(dockPane(row, "tab:chat", { edge: "start" }), null);
});

test("arrow steps: up and down trade places, left and right join the next column or open one at the end", () => {
  let layout = popOutTab(defaultTableLayout(), "notes");
  assert.deepEqual(ids(layout), [["rail"], ["table"], ["panel", "tab:notes"]]);
  layout = stepPane(layout, "tab:notes", "up");
  assert.deepEqual(ids(layout), [["rail"], ["table"], ["tab:notes", "panel"]]);
  assert.deepEqual(ids(stepPane(layout, "tab:notes", "up")), ids(layout), "the top holds");
  layout = stepPane(layout, "tab:notes", "left");
  assert.deepEqual(ids(layout), [["rail"], ["tab:notes", "table"], ["panel"]]);
  layout = stepPane(layout, "tab:notes", "left");
  assert.deepEqual(ids(layout), [["tab:notes", "rail"], ["table"], ["panel"]]);
  layout = stepPane(layout, "tab:notes", "left");
  assert.deepEqual(ids(layout), [["tab:notes"], ["rail"], ["table"], ["panel"]], "past the last column, a new one");
  assert.deepEqual(ids(stepPane(layout, "tab:notes", "left")), ids(layout), "alone at the edge it stays");
  // A pane alone in its column joins the next one, and its column closes.
  const joined = stepPane(defaultTableLayout(), "rail", "right");
  assert.deepEqual(ids(joined), [["rail", "table"], ["panel"]]);
});

test("a floating pane steps by a little, or a lot with shift, and never leaves the row", () => {
  let layout = floatPane(popOutTab(defaultTableLayout(), "notes"), "tab:notes");
  const start = layout.floating[0];
  layout = stepPane(layout, "tab:notes", "right");
  assert.ok(Math.abs(layout.floating[0].x - (start.x + 0.02)) < 1e-9);
  for (let i = 0; i < 40; i += 1) layout = stepPane(layout, "tab:notes", "down", true);
  assert.ok(layout.floating[0].y + layout.floating[0].h <= 1 + 1e-9);
});

test("a tab's own pane: under the side panel, beside it when full, shown again if it exists, and back to the rail", () => {
  let layout = popOutTab(defaultTableLayout(), "party");
  assert.deepEqual(ids(layout), [["rail"], ["table"], ["panel", "tab:party"]]);
  assert.deepEqual(poppedTabs(layout), ["party"]);
  for (const tab of ["map", "story"]) layout = popOutTab(layout, tab);
  assert.deepEqual(ids(layout)[2], ["panel", "tab:party", "tab:map", "tab:story"]);
  layout = popOutTab(layout, "notes");
  assert.deepEqual(ids(layout), [["rail"], ["table"], ["tab:notes"], ["panel", "tab:party", "tab:map", "tab:story"]]);
  layout = popOutTab(layout, "chat");
  assert.deepEqual(layout.floating.map((pane) => pane.id), ["tab:chat"], "a full row sets it afloat");
  layout = setPaneHidden(layout, "tab:map", true);
  assert.ok(isPaneHidden(layout, "tab:map"));
  assert.deepEqual(hiddenPanes(layout), ["tab:map"]);
  layout = popOutTab(layout, "map");
  assert.ok(!isPaneHidden(layout, "tab:map"), "popping out a hidden pane shows it");
  layout = returnTab(layout, "tab:notes");
  assert.ok(!poppedTabs(layout).includes("notes"));
  assert.equal(layout.columns.length, 3);
  assert.equal(returnTab(layout, "panel"), layout, "only a tab's pane goes back to the rail");
});

test("hide and show: the table never hides, the portraits remember an explicit shown", () => {
  const start = defaultTableLayout();
  assert.equal(setPaneHidden(start, "table", true), start);
  const hidden = setPaneHidden(start, "rail", true);
  assert.equal(hidden.columns[0].panes[0].hidden, true);
  const shown = setPaneHidden(hidden, "rail", false);
  assert.equal(shown.columns[0].panes[0].hidden, false, "shown on purpose, whatever the width");
  assert.ok(!isDefaultShape(shown));
  const panel = setPaneHidden(setPaneHidden(start, "panel", true), "panel", false);
  assert.equal(panel.columns[2].panes[0].hidden, undefined);
  assert.ok(isDefaultShape(panel));
});

test("afloat and back: never the table, at most four, docked back under the side panel", () => {
  const start = defaultTableLayout();
  assert.equal(floatPane(start, "table"), null);
  let layout = floatPane(start, "rail");
  assert.deepEqual(ids(layout), [["table"], ["panel"]]);
  assert.equal(layout.floating[0].id, "rail");
  layout = moveFloating(layout, "rail", { x: 2, y: 0.5, w: 0.5, h: 0.4 });
  assert.deepEqual(layout.floating[0], { id: "rail", x: 0.5, y: 0.5, w: 0.5, h: 0.4 });
  for (const tab of ["notes", "map", "story"]) layout = floatPane(popOutTab(layout, tab), `tab:${tab}`) ?? layout;
  assert.equal(layout.floating.length, 4);
  assert.equal(floatPane(popOutTab(layout, "chat"), "tab:chat"), null);
  layout = raiseFloating(layout, "rail");
  assert.equal(layout.floating.at(-1).id, "rail");
  layout = dockFloating(layout, "rail");
  assert.deepEqual(ids(layout).at(-1), ["panel", "rail"]);
});

test("lock, the chronicle's width and the side panel's widen button", () => {
  assert.equal(setLocked(defaultTableLayout(), true).locked, true);
  assert.equal(setChronicle(defaultTableLayout(), 50).chronicle, 200);
  assert.equal(setChronicle(defaultTableLayout(), null).chronicle, null);
  assert.equal(panelWidth(setPanelWidth(defaultTableLayout(), PANEL_WIDE)), PANEL_WIDE);
  const panelWithTable = dockPane(defaultTableLayout(), "panel", { pane: "table", edge: "bottom" });
  assert.equal(panelWidth(panelWithTable), null);
  assert.equal(setPanelWidth(panelWithTable, 500), panelWithTable);
});

test("geometry: the default row at full width and on a narrower window", () => {
  const wide = tableGeometry(defaultTableLayout(), { width: 1920, height: 900, available: all });
  assert.deepEqual(wide.docked.map((pane) => [pane.id, pane.rect.x, pane.rect.w]), [
    ["rail", 0, RAIL_WIDTH],
    ["table", RAIL_WIDTH, 1920 - RAIL_WIDTH - PANEL_WIDTH],
    ["panel", 1920 - PANEL_WIDTH, PANEL_WIDTH],
  ]);
  inside(wide);
  // Under 1300px the portraits step aside on the table's own rule.
  const laptop = tableGeometry(defaultTableLayout(), { width: 1280, height: 700, available: all });
  assert.deepEqual(laptop.docked.map((pane) => pane.id), ["table", "panel"]);
  assert.equal(laptop.splits.length, 1);
  // Shown on purpose, they stay.
  const shown = tableGeometry(setPaneHidden(defaultTableLayout(), "rail", false), { width: 1280, height: 700, available: all });
  assert.deepEqual(shown.docked.map((pane) => pane.id), ["rail", "table", "panel"]);
  // Not available (the fight stage takes the portraits' place): gone, and
  // no splitter for them.
  const fight = tableGeometry(defaultTableLayout(), { width: 1920, height: 900, available: (id) => id !== "rail" });
  assert.deepEqual(fight.docked.map((pane) => pane.id), ["table", "panel"]);
});

test("geometry: side columns give way before the table drops under its floor, and nothing leaves the row", () => {
  let layout = defaultTableLayout();
  layout = setPanelWidth(layout, 1200);
  layout = popOutTab(layout, "notes");
  layout = dockPane(layout, "tab:notes", { edge: "start" });
  for (const width of [1024, 1100, 1600, 2560]) {
    const geometry = tableGeometry(layout, { width, height: 800, available: all });
    inside(geometry);
    const table = geometry.docked.find((pane) => pane.id === "table");
    assert.ok(table.rect.w >= MIN_TABLE - 1, `the table keeps its floor at ${width}px (${table.rect.w})`);
    const covered = geometry.columns.reduce((sum, column) => sum + column.w, 0);
    assert.equal(covered, width, "the columns fill the row exactly");
  }
});

test("geometry: a stack keeps each pane's floor, and the last pixel goes to the last pane", () => {
  let layout = popOutTab(popOutTab(defaultTableLayout(), "notes"), "map");
  layout.columns[2].panes[0].size = 0.98;
  layout.columns[2].panes[1].size = 0.01;
  layout.columns[2].panes[2].size = 0.01;
  const geometry = tableGeometry(layout, { width: 1600, height: 801, available: all });
  const stack = geometry.docked.filter((pane) => pane.column === 2);
  assert.equal(stack.length, 3);
  for (const pane of stack) assert.ok(pane.rect.h >= MIN_PANE_HEIGHT - 1, `${pane.id} keeps its floor`);
  assert.equal(stack.reduce((sum, pane) => sum + pane.rect.h, 0), 801);
  assert.equal(geometry.splits.filter((split) => split.kind === "stack").length, 2);
  // A hidden pane in the stack gives its room to the others.
  const hidden = tableGeometry(setPaneHidden(layout, "tab:notes", true), { width: 1600, height: 800, available: all });
  assert.deepEqual(hidden.docked.filter((pane) => pane.column === 2).map((pane) => pane.id), ["panel", "tab:map"]);
});

test("geometry: a floating pane stays whole inside the row however small the window gets", () => {
  let layout = floatPane(popOutTab(defaultTableLayout(), "notes"), "tab:notes");
  layout = moveFloating(layout, "tab:notes", { x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
  for (const [width, height] of [[1920, 1000], [1024, 600], [300, 150]]) {
    const geometry = tableGeometry(layout, { width, height, available: all });
    inside(geometry);
    assert.equal(geometry.floating.length, 1);
  }
});

test("splitters: the portraits', the side panel's, two side columns', and a stack's", () => {
  const layout = defaultTableLayout();
  const geometry = tableGeometry(layout, { width: 1920, height: 900, available: all });
  const [railSplit, panelSplit] = geometry.splits;
  assert.equal(railSplit.value, RAIL_WIDTH);
  assert.equal(panelSplit.value, PANEL_WIDTH);
  assert.equal(applySplit(layout, geometry, railSplit, 300).columns[0].width, 300);
  assert.equal(panelWidth(applySplit(layout, geometry, panelSplit, 600)), 600);
  // Clamped: never under the floor, never past the table's.
  assert.equal(applySplit(layout, geometry, railSplit, 10).columns[0].width, 200);
  const huge = applySplit(layout, geometry, panelSplit, 5000);
  assert.equal(panelWidth(huge), 1920 - RAIL_WIDTH - MIN_TABLE);
  // Two side columns side by side: the pair keeps its total.
  const pair = dockPane(layout, "rail", { pane: "panel", edge: "left" });
  const pairGeometry = tableGeometry(pair, { width: 1920, height: 900, available: all });
  const between = pairGeometry.splits.find((split) => split.kind === "columns" && split.left === 1 && split.right === 2);
  const resized = applySplit(pair, pairGeometry, between, 300);
  assert.equal(resized.columns[1].width, 300);
  assert.equal(resized.columns[2].width, RAIL_WIDTH + PANEL_WIDTH - 300);
  // A stack: the pane above takes the new height, the one below the rest.
  const stacked = popOutTab(layout, "notes");
  const stackGeometry = tableGeometry(stacked, { width: 1920, height: 900, available: all });
  const split = stackGeometry.splits.find((entry) => entry.kind === "stack");
  const next = applySplit(stacked, stackGeometry, split, 600);
  const after = tableGeometry(next, { width: 1920, height: 900, available: all }).docked.filter((pane) => pane.column === 2);
  assert.deepEqual(after.map((pane) => pane.rect.h), [600, 300]);
});

test("dragging over the row: ends open a column, edges dock beside, the middle swaps", () => {
  const layout = popOutTab(defaultTableLayout(), "notes");
  const geometry = tableGeometry(layout, { width: 1920, height: 900, available: all });
  assert.deepEqual(dropTarget(layout, geometry, "tab:notes", 5, 400), { edge: "start" });
  assert.deepEqual(dropTarget(layout, geometry, "tab:notes", 1915, 400), { edge: "end" });
  const table = geometry.docked.find((pane) => pane.id === "table").rect;
  assert.deepEqual(dropTarget(layout, geometry, "tab:notes", table.x + table.w / 2, table.y + table.h / 2), { pane: "table", edge: "center" });
  assert.deepEqual(dropTarget(layout, geometry, "tab:notes", table.x + 10, table.y + table.h / 2), { pane: "table", edge: "left" });
  assert.deepEqual(dropTarget(layout, geometry, "tab:notes", table.x + table.w / 2, table.y + 10), { pane: "table", edge: "top" });
  // Over itself, nothing.
  const notes = geometry.docked.find((pane) => pane.id === "tab:notes").rect;
  assert.equal(dropTarget(layout, geometry, "tab:notes", notes.x + notes.w / 2, notes.y + notes.h / 2), null);
  const rect = dropRect(geometry, { pane: "table", edge: "bottom" });
  assert.deepEqual(rect, { x: table.x, y: table.y + table.h / 2, w: table.w, h: table.h / 2 });
});

test("every edit reads back as itself", () => {
  let layout = defaultTableLayout();
  layout = popOutTab(layout, "notes");
  layout = floatPane(layout, "rail");
  layout = setPaneHidden(layout, "tab:notes", true);
  layout = setLocked(setChronicle(layout, 420), true);
  assert.deepEqual(roundTrip(layout), layout);
});

console.log(`table layout: ${passed} passed`);
