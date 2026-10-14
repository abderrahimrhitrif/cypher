import { App, Modal, Setting } from "obsidian";

/** Promise-based text prompt; resolves to `null` when dismissed. */
export class PromptModal extends Modal {
  private value: string;
  private resolved = false;
  private resolve: (value: string | null) => void;

  constructor(
    app: App,
    private title: string,
    initialValue: string,
    private placeholder: string,
    resolve: (value: string | null) => void
  ) {
    super(app);
    this.value = initialValue;
    this.resolve = resolve;
  }

  public onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.title });

    const input = this.contentEl.createEl("input", {
      type: "text",
      value: this.value,
      cls: "cypher-prompt-input",
    });
    input.placeholder = this.placeholder;
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => this.submit())
      );

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private submit(): void {
    this.finish(this.value.trim() || null);
    this.close();
  }

  private finish(value: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
  }

  public onClose(): void {
    this.contentEl.empty();
    this.finish(null);
  }
}

/** Promise-based confirmation dialog used for destructive actions. */
export class ConfirmModal extends Modal {
  private resolved = false;
  private resolve: (value: boolean) => void;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel: string,
    resolve: (value: boolean) => void
  ) {
    super(app);
    this.resolve = resolve;
  }

  public onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.finish(true);
            this.close();
          })
      );
  }

  private finish(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
  }

  public onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }
}

export function promptText(
  app: App,
  title: string,
  initialValue: string,
  placeholder = ""
): Promise<string | null> {
  return new Promise((resolve) => {
    new PromptModal(app, title, initialValue, placeholder, resolve).open();
  });
}

export function confirmAction(
  app: App,
  title: string,
  message: string,
  confirmLabel: string
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, message, confirmLabel, resolve).open();
  });
}
