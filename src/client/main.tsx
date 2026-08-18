import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

interface AppErrorBoundaryState {
  failed: boolean;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Application render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-error-page notranslate" translate="no">
        <section className="fatal-error-card" role="alert">
          <div className="fatal-error-icon" aria-hidden="true">!</div>
          <h1>页面暂时无法显示</h1>
          <p>浏览器可能修改了页面内容。请关闭网页自动翻译，然后重新加载。</p>
          <button className="primary large" type="button" onClick={() => window.location.reload()}>
            重新加载页面
          </button>
        </section>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
