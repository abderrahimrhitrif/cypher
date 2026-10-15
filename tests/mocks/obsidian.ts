import { vi } from "vitest";

/** Minimal Obsidian API surface used by the services under test. */

export const requestUrl = vi.fn(async (_options: unknown) => ({
  status: 200,
  text: "",
  json: {},
  arrayBuffer: new ArrayBuffer(0),
  headers: {},
}));

export class Notice {
  public message: string;

  constructor(message: string) {
    this.message = message;
  }

  public setMessage(message: string): this {
    this.message = message;
    return this;
  }

  public hide(): void {}
}

export class TFile {
  public path: string;
  public name: string;
  public basename: string;
  public extension: string;
  public parent: TFolder | null = null;
  public stat = { mtime: 0, ctime: 0, size: 0 };

  constructor(path = "note.md") {
    this.path = path;
    const segments = path.split("/");
    this.name = segments[segments.length - 1];
    this.extension = this.name.includes(".") ? this.name.split(".").pop()! : "";
    this.basename = this.extension
      ? this.name.slice(0, -(this.extension.length + 1))
      : this.name;
  }
}

export class TFolder {
  public path: string;

  constructor(path = "/") {
    this.path = path;
  }
}

export class Vault {}
export class MetadataCache {}
export class DataAdapter {}
export class App {}
export class WorkspaceLeaf {}
export class ItemView {}
export class Plugin {}
export class PluginSettingTab {}
export class MarkdownRenderer {}
export class FileSystemAdapter {}

export function setIcon(): void {}
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class Modal {
  public contentEl = createElementStub();

  constructor(public app: App) {}

  public open(): void {}
  public close(): void {}
  public onOpen(): void {}
  public onClose(): void {}
}

export class Setting {
  constructor(public containerEl: unknown) {}
  public setName(): this {
    return this;
  }
  public setDesc(): this {
    return this;
  }
  public setHeading(): this {
    return this;
  }
  public addText(): this {
    return this;
  }
  public addTextArea(): this {
    return this;
  }
  public addButton(): this {
    return this;
  }
  public addToggle(): this {
    return this;
  }
  public addSlider(): this {
    return this;
  }
  public addDropdown(): this {
    return this;
  }
}

function createElementStub(): Record<string, unknown> {
  return {
    empty: () => undefined,
    addClass: () => undefined,
    removeClass: () => undefined,
    toggleClass: () => undefined,
    createDiv: () => createElementStub(),
    createSpan: () => createElementStub(),
    createEl: () => createElementStub(),
    setText: () => undefined,
    setAttr: () => undefined,
  };
}
