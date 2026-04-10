export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementNode {
  type: string;
  label: string | null;
  value: string | null;
  frame: Frame;
  enabled: boolean;
  children: ElementNode[];
}

export interface Device {
  udid: string;
  name: string;
  state: "booted" | "shutdown" | "unknown";
  type: "simulator" | "device";
}

export interface DeviceDriver {
  screenshot(): Promise<Buffer>;
  accessibilityTree(): Promise<ElementNode[]>;
  tap(x: number, y: number): Promise<void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
  ): Promise<void>;
  typeText(text: string): Promise<void>;
  pressButton(button: "home" | "lock"): Promise<void>;
  launchApp(bundleId: string): Promise<void>;
  terminateApp(bundleId: string): Promise<void>;
  listDevices(): Promise<Device[]>;
  cleanup(): Promise<void>;
}

export function frameCenterX(frame: Frame): number {
  return frame.x + frame.width / 2;
}

export function frameCenterY(frame: Frame): number {
  return frame.y + frame.height / 2;
}

export function flattenTree(nodes: ElementNode[]): ElementNode[] {
  const result: ElementNode[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...flattenTree(node.children));
  }
  return result;
}

export function findElementByLabel(
  nodes: ElementNode[],
  query: string,
): ElementNode | null {
  const flat = flattenTree(nodes);
  const queryLower = query.toLowerCase();

  // Exact match on label
  const exact = flat.find(
    (n) => n.label?.toLowerCase() === queryLower,
  );
  if (exact) return exact;

  // Exact match on value
  const valueMatch = flat.find(
    (n) => n.value?.toLowerCase() === queryLower,
  );
  if (valueMatch) return valueMatch;

  // Partial match on label
  const partial = flat.find(
    (n) => n.label?.toLowerCase().includes(queryLower),
  );
  if (partial) return partial;

  // Partial match on value
  const partialValue = flat.find(
    (n) => n.value?.toLowerCase().includes(queryLower),
  );
  if (partialValue) return partialValue;

  return null;
}
