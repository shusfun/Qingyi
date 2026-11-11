export function button(
  label: string,
  action?: (event: MouseEvent) => unknown,
  kind?: string,
): HTMLButtonElement;
export function details(label: string, value: unknown): HTMLDetailsElement;
export function status(node: HTMLElement, message: string, tone?: string): void;
export function empty(node: HTMLElement, message: string): void;
export function records<T>(
  node: HTMLElement,
  items: T[],
  describe: (item: T) => string,
  emptyText: string,
): void;
export function confirmAction(
  message: string,
  title?: string,
  confirmLabel?: string,
): Promise<boolean>;
export function toast(message: string): void;
export function applyTheme(theme: string): void;
export function createDrafts(root?: Document): {
  has(id: string): boolean;
  clear(ids: string[], saved?: [string, string, boolean][]): void;
  write(id: string, value: unknown, checked?: boolean): void;
  snapshot(): [string, string, boolean][];
  restore(saved: [string, string, boolean][]): void;
  any(): boolean;
};
