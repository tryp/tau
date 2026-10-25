import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
    extractFinalContent,
    extractPageContent,
} from "../features/web-browse/index.ts";
import { domToMarkdown } from "../features/web-browse/markdown.ts";
import { domToStructure } from "../features/web-browse/structure.ts";

const NodeKinds = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

class FixtureNode {
    readonly childNodes: FixtureNode[];
    readonly nodeType: number;

    readonly text: string;

    constructor(text: string) {
        this.text = text;
        this.nodeType = NodeKinds.TEXT_NODE;
        this.childNodes = [];
    }

    get textContent(): string {
        return this.text;
    }
}

class FixtureElement {
    readonly nodeType = NodeKinds.ELEMENT_NODE;
    readonly childNodes: Array<FixtureElement | FixtureNode>;
    readonly children: FixtureElement[];
    readonly tagName: string;
    readonly id: string;
    readonly className: string;

    private readonly attributes: Record<string, string>;

    constructor(
        tag: string,
        children: Array<FixtureElement | FixtureNode> = [],
        attributes: Record<string, string> = {}
    ) {
        this.attributes = attributes;
        this.tagName = tag.toUpperCase();
        this.childNodes = children;
        this.children = children.filter(
            (child): child is FixtureElement => child instanceof FixtureElement
        );
        this.id = attributes.id ?? "";
        this.className = attributes.class ?? "";
    }

    get textContent(): string {
        return this.childNodes.map((child) => child.textContent).join("");
    }

    get innerText(): string {
        return this.textContent;
    }

    get href(): string {
        return this.getAttribute("href") ?? "";
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FixtureElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FixtureElement[] {
        const selectors = selector.split(",").map((part) => part.trim());
        const descendants: FixtureElement[] = [];
        const visit = (element: FixtureElement) => {
            for (const child of element.children) {
                descendants.push(child);
                visit(child);
            }
        };
        visit(this);
        return descendants.filter((element) =>
            selectors.some((part) => matches(element, part))
        );
    }
}

function matches(element: FixtureElement, selector: string): boolean {
    if (selector === "main, article, #content, .content") {
        return (
            ["MAIN", "ARTICLE"].includes(element.tagName) ||
            element.id === "content" ||
            element.className.split(" ").includes("content")
        );
    }
    const attr = selector.match(
        /^([a-z]+)\[([^=\]]+)(?:=['"]?([^\]'" ]+)['"]?)?\]$/i
    );
    if (attr) {
        const [, tag, name, value] = attr;
        return (
            element.tagName.toLowerCase() === tag.toLowerCase() &&
            element.getAttribute(name) !== null &&
            (value === undefined || element.getAttribute(name) === value)
        );
    }
    if (/^h[1-6]$/.test(selector))
        return element.tagName.toLowerCase() === selector;
    if (selector.startsWith("#")) return element.id === selector.slice(1);
    if (selector.startsWith("."))
        return element.className.split(" ").includes(selector.slice(1));
    return element.tagName.toLowerCase() === selector.toLowerCase();
}

function fixtureDocument(title: string, url: string, paragraph: string) {
    const main = new FixtureElement("main", [
        new FixtureElement("h1", [new FixtureNode(title)]),
        new FixtureElement("p", [
            new FixtureNode(paragraph),
            new FixtureNode(" "),
            new FixtureElement("a", [new FixtureNode("Fixture link")], {
                href: `${url}/more`,
            }),
        ]),
    ]);
    const meta = new FixtureElement("meta", [], {
        name: "description",
        content: `About ${title}`,
    });
    return {
        title,
        contentType: "text/html",
        body: main,
        querySelector(selector: string) {
            if (selector === "main") return main;
            if (selector === 'meta[name="description"]') return meta;
            return null;
        },
    };
}

/**
 * Patchright-shaped page model. Init scripts and script tags populate the main
 * world, while every evaluate serializes its callback into a fresh isolated
 * vm context with the current document. Navigation replaces document/world.
 */
function isolatedPage(initial: {
    title: string;
    url: string;
    paragraph: string;
}) {
    let current = initial;
    const makeMainWorld = () => {
        const world: Record<string, unknown> = {};
        world.window = world;
        return world;
    };
    let mainWorld = makeMainWorld();
    const page = {
        url: () => current.url,
        addInitScript: async ({ content }: { content: string }) => {
            mainWorld = makeMainWorld();
            runInNewContext(content, mainWorld);
        },
        addScriptTag: async ({ content }: { content: string }) => {
            runInNewContext(content, mainWorld);
        },
        navigate(next: { title: string; url: string; paragraph: string }) {
            current = next;
            mainWorld = makeMainWorld();
            if (initScript) runInNewContext(initScript, mainWorld);
        },
        evaluate: async (
            callback: (...args: never[]) => unknown,
            ...args: unknown[]
        ) => {
            const document = fixtureDocument(
                current.title,
                current.url,
                current.paragraph
            );
            const window = { location: { href: current.url } };
            const context = { document, window, Node: NodeKinds };
            return runInNewContext(`(${callback.toString()})(...__args)`, {
                ...context,
                __args: args,
            }) as unknown;
        },
        mainWorld: () => mainWorld,
    };
    let initScript = "";
    return {
        page,
        installConverters: async () => {
            initScript = `window.__domToMarkdown = ${domToMarkdown.toString()}; window.__domToStructure = ${domToStructure.toString()};`;
            await page.addInitScript({ content: initScript });
        },
    };
}

const consoleCollector = { messages: [], getFormatted: () => "" } as never;
const first = {
    title: "First document",
    url: "https://fixture.invalid/first",
    paragraph: "First body text.",
};
const afterNavigation = {
    title: "Second document",
    url: "https://fixture.invalid/second",
    paragraph: "Second body text.",
};
const expectedMarkdown = (fixture: typeof first) =>
    `# ${fixture.title}\n\n> About ${fixture.title}\n\nSource: ${fixture.url}\n\n---\n\n# ${fixture.title}\n\n${fixture.paragraph} [Fixture link](${fixture.url}/more)\n`;
const expectedStructure = (fixture: typeof first) => ({
    title: fixture.title,
    url: fixture.url,
    description: `About ${fixture.title}`,
    headings: [{ level: 1, text: fixture.title, id: undefined }],
    sections: [
        {
            heading: fixture.title,
            level: 1,
            content: [
                {
                    type: "paragraph",
                    text: `${fixture.paragraph} Fixture link`,
                },
            ],
        },
    ],
    links: [{ text: "Fixture link", href: `${fixture.url}/more` }],
});

for (const [format, expected] of [
    ["markdown", expectedMarkdown],
    ["structure", expectedStructure],
] as const) {
    void test(`web_browse ${format} evaluates its converter in the isolated world after navigation`, async () => {
        const { page, installConverters } = isolatedPage(first);
        await installConverters();
        assert.equal(
            typeof (page.mainWorld() as { __domToMarkdown?: unknown })
                .__domToMarkdown,
            "function"
        );
        assert.equal(
            typeof (page.mainWorld() as { __domToStructure?: unknown })
                .__domToStructure,
            "function"
        );
        page.navigate(afterNavigation);
        assert.equal(
            await page.evaluate(() => typeof window.__domToMarkdown),
            "undefined"
        );
        assert.equal(
            await page.evaluate(() => typeof window.__domToStructure),
            "undefined"
        );
        const result = await extractPageContent(
            page as never,
            { format, url: afterNavigation.url },
            consoleCollector,
            "isolated"
        );
        assert.equal(
            result.content[0].text,
            format === "markdown"
                ? expected(afterNavigation)
                : JSON.stringify(expected(afterNavigation), null, 2)
        );
    });

    void test(`web_interact final ${format} evaluates its converter in the isolated world after navigation`, async () => {
        const { page, installConverters } = isolatedPage(first);
        await installConverters();
        await page.addScriptTag({
            content: `window.__domToMarkdown = ${domToMarkdown.toString()}; window.__domToStructure = ${domToStructure.toString()};`,
        });
        page.navigate(afterNavigation);
        assert.equal(
            await page.evaluate(() => typeof window.__domToMarkdown),
            "undefined"
        );
        assert.equal(
            await page.evaluate(() => typeof window.__domToStructure),
            "undefined"
        );
        const content = await extractFinalContent(page as never, format);
        assert.equal(
            content,
            format === "markdown"
                ? expected(afterNavigation)
                : JSON.stringify(expected(afterNavigation), null, 2)
        );
    });
}

void test("web_browse structure extraction also works after a CDP-style document change", async () => {
    const { page, installConverters } = isolatedPage(first);
    await installConverters();
    page.navigate(afterNavigation);
    const result = await extractPageContent(
        page as never,
        { format: "structure", url: afterNavigation.url },
        consoleCollector,
        "cdp"
    );
    assert.equal(result.details.browser, "cdp");
    assert.equal(
        result.content[0].text,
        JSON.stringify(expectedStructure(afterNavigation), null, 2)
    );
});

void test("web_browse and web_interact text extraction reads the current document without converter globals", async () => {
    const { page } = isolatedPage(afterNavigation);
    const browse = await extractPageContent(
        page as never,
        { format: "text", url: afterNavigation.url },
        consoleCollector,
        "isolated"
    );
    assert.match(browse.content[0].text, /Second body text\./);
    assert.match(
        await extractFinalContent(page as never, "text"),
        /Second body text\./
    );
});
