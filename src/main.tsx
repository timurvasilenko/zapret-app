import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./i18n";
import "./index.css";

type ErrorBoundaryProps = {
    children: React.ReactNode;
};

type ErrorBoundaryState = {
    hasError: boolean;
    message: string;
};

async function logFrontendError(message: string, context?: string) {
    try {
        await invoke("log_frontend_error", { message, context });
    } catch {
        // noop
    }
}

class AppErrorBoundary extends React.Component<
    ErrorBoundaryProps,
    ErrorBoundaryState
> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, message: "" };
    }

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return {
            hasError: true,
            message: String(error),
        };
    }

    componentDidCatch(error: unknown, info: React.ErrorInfo) {
        void logFrontendError(String(error), `error-boundary\n${info.componentStack}`);
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
                <div className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-sm">
                    <h1 className="text-lg font-semibold">
                        Приложение столкнулось с ошибкой
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        Вместо белого экрана показан аварийный экран. Можно
                        перезапустить окно или закрыть приложение.
                    </p>
                    <pre className="mt-3 max-h-40 overflow-auto rounded border border-border bg-muted/40 p-2 text-xs">
                        {this.state.message}
                    </pre>
                    <div className="mt-4 flex gap-2">
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="rounded border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
                        >
                            Перезапустить окно
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void getCurrentWindow().close().catch(() => {});
                            }}
                            className="rounded border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
                        >
                            Закрыть
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

document.documentElement.classList.add("dark");

window.addEventListener("error", (event) => {
    const stack = event.error instanceof Error ? `\n${event.error.stack ?? ""}` : "";
    const message = `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}${stack}`;
    void logFrontendError(message, "window.error");
});

window.addEventListener("unhandledrejection", (event) => {
    const reason =
        event.reason instanceof Error
            ? `${event.reason.message}\n${event.reason.stack ?? ""}`
            : String(event.reason);
    void logFrontendError(reason, "window.unhandledrejection");
});

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
    <AppErrorBoundary>
        <App />
    </AppErrorBoundary>,
);

void logFrontendError("frontend bootstrap started", "startup");
void invoke("frontend_ready").catch(() => {});
