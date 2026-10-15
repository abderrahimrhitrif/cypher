import { beforeEach, describe, expect, it } from "vitest";
import { ConversationService } from "../src/services/conversationService";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ConversationService", () => {
  let service: ConversationService;

  beforeEach(async () => {
    service = new ConversationService();
    await service.clearAll();
  });

  it("creates, reads, and lists conversations", async () => {
    const conversation = await service.create("First chat");

    expect(conversation.id).toMatch(/^conv-/);
    expect(conversation.messages).toEqual([]);

    const found = await service.get(conversation.id);
    expect(found).toMatchObject({ title: "First chat" });

    const all = await service.getAll();
    expect(all.map((item) => item.id)).toContain(conversation.id);
  });

  it("stores messages and updates the timestamp when saved", async () => {
    const conversation = await service.create("Chat");
    const before = conversation.updatedAt;

    await wait(5);
    conversation.messages.push({
      id: "m1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    });
    await service.save(conversation);

    expect(conversation.updatedAt).toBeGreaterThanOrEqual(before);

    const reloaded = await service.get(conversation.id);
    expect(reloaded?.messages).toHaveLength(1);
    expect(reloaded?.messages[0].content).toBe("Hello");
  });

  it("renames conversations and rejects empty titles", async () => {
    const conversation = await service.create("Chat");

    expect(await service.rename(conversation.id, "  Roadmap  ")).toBe(true);
    expect((await service.get(conversation.id))?.title).toBe("Roadmap");

    expect(await service.rename(conversation.id, "   ")).toBe(true);
    expect((await service.get(conversation.id))?.title).toBe("Untitled Chat");

    expect(await service.rename("missing", "Nope")).toBe(false);
  });

  it("deletes conversations and clears everything", async () => {
    const first = await service.create("One");
    const second = await service.create("Two");

    expect(await service.delete(first.id)).toBe(true);
    expect(await service.get(first.id)).toBeUndefined();

    await service.clearAll();
    expect(await service.getAll()).toEqual([]);
    expect(await service.get(second.id)).toBeUndefined();
  });

  it("orders conversations by most recently updated", async () => {
    const first = await service.create("Older");
    await wait(5);
    const second = await service.create("Newer");

    const all = await service.getAll();
    expect(all[0].id).toBe(second.id);
    expect(all[1].id).toBe(first.id);
  });

  it("generates short titles from the first message", () => {
    expect(service.generateTitleFromContent("# Hello **world**")).toBe("Hello world");
    expect(service.generateTitleFromContent("   ")).toBe("New Chat");
    expect(
      service.generateTitleFromContent("[link](y) `code` _emphasis_")
    ).toBe("linky code emphasis");

    const long = service.generateTitleFromContent(
      "This is a reasonably long sentence that should be shortened for the sidebar title"
    );
    expect(long.endsWith("...")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(41);
  });
});
