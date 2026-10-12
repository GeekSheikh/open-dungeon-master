// Where the table's panes land in pixels (client issue 46): the row's
// columns and stacks laid out in the space the window gives them, the
// splitters between them, a splitter's new length written back, and where
// a pane dragged over the row would dock. The arrangement itself is
// src/lib/table-layout.ts; this file only measures it. Pure, like that one,
// for scripts/test-table-layout.mjs.

import {
  copyLayout,
  dockPane,
  MIN_COLUMN,
  MIN_FLOAT_HEIGHT,
  MIN_FLOAT_WIDTH,
  MIN_PANE_HEIGHT,
  MIN_TABLE,
  PANE_WIDTH,
  RAIL_AUTO_WIDTH,
  tidyLayout,
  type DockTarget,
  type PaneId,
  type TableLayout,
} from "./table-layout.ts";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type Rect = { x: number; y: number; w: number; h: number };

// A splitter moves one length: a column's width, or the height of the pane
// above it. `value` is that length now, `min` and `max` what it may become.
export type ColumnSplit = {
  kind: "columns";
  key: string;
  left: number;
  right: number;
  x: number;
  y: number;
  h: number;
  value: number;
  min: number;
  max: number;
};
export type StackSplit = {
  kind: "stack";
  key: string;
  column: number;
  above: number;
  below: number;
  x: number;
  y: number;
  w: number;
  value: number;
  min: number;
  max: number;
};
export type Split = ColumnSplit | StackSplit;

export type PlacedPane = { id: PaneId; rect: Rect; column: number; index: number };
export type FloatingPlaced = { id: PaneId; rect: Rect; index: number };
export type TableGeometry = {
  width: number;
  height: number;
  // Shown docked columns, model index and box.
  columns: Array<{ index: number; x: number; w: number; flex: boolean }>;
  docked: PlacedPane[];
  floating: FloatingPlaced[];
  splits: Split[];
};

// Whether a pane is drawn: its content exists for this viewer right now
// (`available`: no portraits mid-fight, no Battle pane without a board),
// it is not hidden, and the portraits on the table's own rule have room.
export function paneShown(id: PaneId, hidden: boolean | undefined, available: (id: PaneId) => boolean, width: number): boolean {
  if (!available(id)) return false;
  if (hidden === true) return false;
  if (hidden === undefined && id === "rail") return width >= RAIL_AUTO_WIDTH;
  return true;
}

// Heights for a stack: the saved shares, each at least the floor while the
// column has room for every floor, the last pixel given to the last pane.
function stackHeights(sizes: number[], height: number): number[] {
  const count = sizes.length;
  if (height < count * MIN_PANE_HEIGHT) {
    return sizes.map(() => height / count);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  const heights = sizes.map((size) => (size / total) * height);
  for (let pass = 0; pass < count; pass += 1) {
    const short = heights.map((h) => h < MIN_PANE_HEIGHT);
    if (!short.some(Boolean)) break;
    const need = heights.reduce((sum, h, i) => sum + (short[i] ? MIN_PANE_HEIGHT - h : 0), 0);
    const spare = heights.reduce((sum, h, i) => sum + (short[i] ? 0 : h - MIN_PANE_HEIGHT), 0);
    for (let i = 0; i < count; i += 1) {
      heights[i] = short[i] ? MIN_PANE_HEIGHT : heights[i] - (spare > 0 ? ((heights[i] - MIN_PANE_HEIGHT) / spare) * need : 0);
    }
  }
  return heights;
}

export function tableGeometry(
  layout: TableLayout,
  { width, height, available }: { width: number; height: number; available: (id: PaneId) => boolean },
): TableGeometry {
  const W = Math.max(0, width);
  const H = Math.max(0, height);
  const shownColumns = layout.columns
    .map((column, index) => ({
      index,
      column,
      panes: column.panes
        .map((pane, paneIndex) => ({ pane, paneIndex }))
        .filter(({ pane }) => paneShown(pane.id, pane.hidden, available, W)),
    }))
    .filter((entry) => entry.panes.length > 0 || entry.column.width === null);
  // Widths: each side column its own, the table's column the rest; when
  // the window is too narrow for that and the table's floor, the side
  // columns give way in proportion, so nothing ever lies past the edge.
  const sides = shownColumns.filter((entry) => entry.column.width !== null);
  const wanted = sides.reduce((sum, entry) => sum + (entry.column.width ?? 0), 0);
  const room = Math.max(0, W - MIN_TABLE);
  const scale = wanted > room ? (wanted > 0 ? room / wanted : 0) : 1;
  const widths = shownColumns.map((entry) => (entry.column.width === null ? 0 : Math.floor((entry.column.width ?? 0) * scale)));
  const used = widths.reduce((sum, w) => sum + w, 0);
  const columns: TableGeometry["columns"] = [];
  const docked: PlacedPane[] = [];
  const splits: Split[] = [];
  let x = 0;
  shownColumns.forEach((entry, i) => {
    const flex = entry.column.width === null;
    const w = flex ? Math.max(0, W - used) : widths[i];
    columns.push({ index: entry.index, x, w, flex });
    const heights = stackHeights(entry.panes.map(({ pane }) => pane.size), H);
    let y = 0;
    entry.panes.forEach(({ pane, paneIndex }, k) => {
      const h = k === entry.panes.length - 1 ? H - y : Math.round(heights[k]);
      docked.push({ id: pane.id, rect: { x, y, w, h }, column: entry.index, index: paneIndex });
      if (k > 0) {
        const above = docked[docked.length - 2];
        const pair = above.rect.h + h;
        splits.push({
          kind: "stack",
          key: `stack:${entry.index}:${above.index}:${paneIndex}`,
          column: entry.index,
          above: above.index,
          below: paneIndex,
          x,
          y,
          w,
          value: above.rect.h,
          min: Math.min(MIN_PANE_HEIGHT, pair / 2),
          max: Math.max(pair - MIN_PANE_HEIGHT, pair / 2),
        });
      }
      y += h;
    });
    x += w;
  });
  // A splitter between each pair of shown columns. It moves the column
  // that is not the table's (the left one when neither is), and the table
  // never drops below its floor.
  const flexWidth = columns.find((column) => column.flex)?.w ?? 0;
  for (let i = 1; i < columns.length; i += 1) {
    const left = columns[i - 1];
    const right = columns[i];
    const moving = left.flex ? right : left;
    const max = left.flex || right.flex ? moving.w + Math.max(0, flexWidth - MIN_TABLE) : left.w + right.w - MIN_COLUMN;
    splits.push({
      kind: "columns",
      key: `columns:${left.index}:${right.index}`,
      left: left.index,
      right: right.index,
      x: right.x,
      y: 0,
      h: H,
      value: moving.w,
      min: Math.min(MIN_COLUMN, moving.w),
      max: Math.max(max, Math.min(MIN_COLUMN, moving.w)),
    });
  }
  const floating: FloatingPlaced[] = [];
  layout.floating.forEach((pane, index) => {
    if (!paneShown(pane.id, pane.hidden, available, W)) return;
    const w = clamp(pane.w * W, Math.min(MIN_FLOAT_WIDTH, W), W);
    const h = clamp(pane.h * H, Math.min(MIN_FLOAT_HEIGHT, H), H);
    floating.push({
      id: pane.id,
      index,
      rect: { x: clamp(pane.x * W, 0, W - w), y: clamp(pane.y * H, 0, H - h), w, h },
    });
  });
  return { width: W, height: H, columns, docked, floating, splits };
}

// A splitter set to a new length (a drag, an arrow key). The side columns
// keep the widths they are drawn at, so a window narrow enough to have
// squeezed them does not make the splitter jump away from the pointer.
export function applySplit(layout: TableLayout, geometry: TableGeometry, split: Split, length: number): TableLayout {
  const value = clamp(length, split.min, split.max);
  const next = copyLayout(layout);
  if (split.kind === "columns") {
    for (const column of geometry.columns) {
      if (!column.flex) next.columns[column.index].width = column.w;
    }
    const left = geometry.columns.find((column) => column.index === split.left);
    const right = geometry.columns.find((column) => column.index === split.right);
    if (!left || !right) return layout;
    if (left.flex) next.columns[right.index].width = value;
    else if (right.flex) next.columns[left.index].width = value;
    else {
      next.columns[left.index].width = value;
      next.columns[right.index].width = left.w + right.w - value;
    }
    return tidyLayout(next);
  }
  const shown = geometry.docked.filter((pane) => pane.column === split.column);
  const height = shown.reduce((sum, pane) => sum + pane.rect.h, 0);
  if (height <= 0) return layout;
  const above = shown.find((pane) => pane.index === split.above);
  const below = shown.find((pane) => pane.index === split.below);
  if (!above || !below) return layout;
  const pair = above.rect.h + below.rect.h;
  const panes = next.columns[split.column].panes;
  // The shown panes' shares become what they are drawn at, the pair split
  // where the splitter was let go; a hidden pane keeps its own share.
  const hiddenShare = panes.reduce((sum, pane, index) => sum + (shown.some((entry) => entry.index === index) ? 0 : pane.size), 0);
  const scale = Math.max(0, 1 - hiddenShare) / height;
  for (const pane of shown) {
    const h = pane.index === split.above ? value : pane.index === split.below ? pair - value : pane.rect.h;
    panes[pane.index].size = Math.max(0.0001, h * scale);
  }
  return tidyLayout(next);
}

// Where a pane being dragged would dock, from the pointer's place in the
// row: the outer strips of the row open a column at that end; over another
// docked pane, its outer quarters dock beside or above or below it and its
// middle swaps the two. Null over nothing that will take it.
export function dropTarget(layout: TableLayout, geometry: TableGeometry, id: PaneId, x: number, y: number): DockTarget | null {
  const edge = Math.min(32, geometry.width * 0.04);
  const candidates: DockTarget[] = [];
  if (x < edge) candidates.push({ edge: "start" });
  else if (x > geometry.width - edge) candidates.push({ edge: "end" });
  else {
    const over = geometry.docked.find(
      (pane) => pane.id !== id && x >= pane.rect.x && x < pane.rect.x + pane.rect.w && y >= pane.rect.y && y < pane.rect.y + pane.rect.h,
    );
    if (!over) return null;
    const fx = (x - over.rect.x) / Math.max(1, over.rect.w);
    const fy = (y - over.rect.y) / Math.max(1, over.rect.h);
    const near = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (near > 0.25) candidates.push({ pane: over.id, edge: "center" });
    else if (near === fx) candidates.push({ pane: over.id, edge: "left" });
    else if (near === 1 - fx) candidates.push({ pane: over.id, edge: "right" });
    else if (near === fy) candidates.push({ pane: over.id, edge: "top" });
    else candidates.push({ pane: over.id, edge: "bottom" });
  }
  return candidates.find((target) => dockPane(layout, id, target) !== null) ?? null;
}

// The box a drop target shows while a pane is dragged over it.
export function dropRect(geometry: TableGeometry, target: DockTarget): Rect | null {
  const band = Math.min(PANE_WIDTH, geometry.width / 4);
  if (!("pane" in target)) {
    return target.edge === "start"
      ? { x: 0, y: 0, w: band, h: geometry.height }
      : { x: geometry.width - band, y: 0, w: band, h: geometry.height };
  }
  const over = geometry.docked.find((pane) => pane.id === target.pane);
  if (!over) return null;
  const { x, y, w, h } = over.rect;
  switch (target.edge) {
    case "left":
      return { x, y: 0, w: Math.min(w / 2, band), h: geometry.height };
    case "right":
      return { x: x + w - Math.min(w / 2, band), y: 0, w: Math.min(w / 2, band), h: geometry.height };
    case "top":
      return { x, y, w, h: h / 2 };
    case "bottom":
      return { x, y: y + h / 2, w, h: h / 2 };
    default:
      return { x, y, w, h };
  }
}

// ---- for the drawing (TableLayout.tsx) ----

// A rect as an absolutely placed box's style.
export const box = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });

export const NO_RECTS: ReadonlyMap<PaneId, Rect> = new Map();

// Where each pane on screen is drawn: all of them as laid out, or the one
// maximized over the whole row.
export function placedRects(geometry: TableGeometry, maximized: PaneId | null): ReadonlyMap<PaneId, Rect> {
  if (maximized) return new Map([[maximized, { x: 0, y: 0, w: geometry.width, h: geometry.height }]]);
  return new Map([...geometry.docked, ...geometry.floating].map((pane) => [pane.id, pane.rect]));
}

// A set of panes as one string, so a memo keyed on it holds while the same
// panes stay on screen (a drag moves them; it does not change which).
export function idsKey(ids: Iterable<PaneId>): string {
  return [...ids].sort().join(" ");
}
