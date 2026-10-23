type ModelIdentity = {
    provider: string;
    baseUrl?: string;
    headers?: Record<string, string | null>;
};

type RequestOptions<T extends ModelIdentity> = {
    model: T;
    headers?: Record<string, string | null>;
    sessionId?: string;
};

/** Normalize model and request headers for bare pi-ai complete() calls. */
export function opencodeSessionOptions<T extends ModelIdentity>(
    model: T,
    sessionId: string | undefined,
    headers?: Record<string, string | null>
): RequestOptions<T> {
    if (!isOpenCodeModel(model)) {
        return {
            model,
            headers,
            ...(sessionId ? { sessionId } : {}),
        };
    }

    const merged: Record<string, string | null> = {};
    const setHeader = (name: string, value: string | null) => {
        const previous = Object.keys(merged).find(
            (key) => key.toLowerCase() === name.toLowerCase()
        );
        if (previous) delete merged[previous];
        merged[name] = value;
    };
    for (const [name, value] of Object.entries(model.headers ?? {})) {
        setHeader(name, value);
    }
    for (const [name, value] of Object.entries(headers ?? {})) {
        setHeader(name, value);
    }

    const hasHeader = (name: string) =>
        Object.keys(merged).some((key) => key.toLowerCase() === name);
    if (sessionId && !hasHeader("x-opencode-session")) {
        setHeader("x-opencode-session", sessionId);
    }
    if (!hasHeader("x-opencode-client")) {
        setHeader("x-opencode-client", "pi");
    }

    const { headers: _modelHeaders, ...modelWithoutHeaders } = model;
    return {
        model: modelWithoutHeaders as T,
        headers: merged,
        ...(sessionId ? { sessionId } : {}),
    };
}

export function isOpenCodeModel(model: ModelIdentity): boolean {
    return (
        model.provider === "opencode" ||
        model.provider === "opencode-go" ||
        isOpenCodeHost(model.baseUrl)
    );
}

function isOpenCodeHost(baseUrl: string | undefined): boolean {
    if (!baseUrl) return false;
    try {
        return new URL(baseUrl).hostname.toLowerCase() === "opencode.ai";
    } catch {
        return false;
    }
}
