# Renderer 独立页面路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Renderer 侧栏菜单改为支持浏览器历史的独立 hash 路由，并让每个路由仅渲染对应模块。

**Architecture:** `App` 保存当前 hash 解析出的路由，并在 `hashchange` 时同步更新。`Navigation` 接收当前路由，输出 `#/…` 链接和当前态。Runtime state 仍在 `App` 中加载并按需传给各页面，避免改变现有 API 调用契约。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、Testing Library、Electron `file://` 打包页面。

---

### Task 1: 定义并测试 hash 路由工具

**Files:**
- Create: `apps/renderer/src/app/routes.ts`
- Create: `apps/renderer/src/app/routes.test.ts`

- [ ] **Step 1: 写入失败测试**

```ts
import { describe, expect, it } from "vitest";
import { normalizeRoute, routes } from "./routes";

describe("normalizeRoute", () => {
  it("uses projects for empty and unknown hashes", () => {
    expect(normalizeRoute("")).toBe("projects");
    expect(normalizeRoute("#/unknown")).toBe("projects");
  });

  it("accepts every declared menu hash", () => {
    for (const route of routes) {
      expect(normalizeRoute(route.hash)).toBe(route.id);
    }
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/routes.test.ts`

Expected: FAIL，原因是 `./routes` 尚不存在。

- [ ] **Step 3: 实现最小路由表和解析函数**

```ts
export const routes = [
  { id: "projects", label: "Projects", hash: "#/projects" },
  { id: "runs", label: "Runs", hash: "#/runs" },
  { id: "workflow", label: "Workflow", hash: "#/workflow" },
  { id: "terminal", label: "Terminal", hash: "#/terminal" },
  { id: "gates", label: "Gates", hash: "#/gates" },
  { id: "artifacts", label: "Artifacts", hash: "#/artifacts" },
  { id: "approvals", label: "Approvals", hash: "#/approvals" },
  { id: "recovery", label: "Recovery", hash: "#/recovery" },
  { id: "settings", label: "Settings", hash: "#/settings" },
] as const;

export type RouteId = (typeof routes)[number]["id"];

export function normalizeRoute(hash: string): RouteId {
  return routes.find((route) => route.hash === hash)?.id ?? "projects";
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/routes.test.ts`

Expected: PASS，2 个断言通过。

### Task 2: 让侧栏反映当前路由

**Files:**
- Modify: `apps/renderer/src/app/navigation.tsx`
- Create: `apps/renderer/src/app/navigation.test.tsx`

- [ ] **Step 1: 写入失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Navigation } from "./navigation";

it("marks the active route and emits hash links", () => {
  render(<Navigation currentRoute="runs" />);

  expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("href", "#/runs");
  expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Projects" })).not.toHaveAttribute("aria-current");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/navigation.test.tsx`

Expected: FAIL，原因是 `Navigation` 尚不接受 `currentRoute`。

- [ ] **Step 3: 为 Navigation 添加路由 props**

```tsx
export function Navigation({ currentRoute }: { currentRoute: RouteId }) {
  return (
    <aside className="sidebar">
      <nav aria-label="主导航" className="nav-list">
        {routes.map((item) => (
          <a
            href={item.hash}
            key={item.id}
            className="nav-link"
            aria-current={item.id === currentRoute ? "page" : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/navigation.test.tsx`

Expected: PASS。

### Task 3: 依据路由渲染单个页面

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: 写入失败测试**

```tsx
it("shows only the selected hash route and responds to browser history", async () => {
  window.location.hash = "#/projects";
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Project Dashboard" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Run Dashboard" })).not.toBeInTheDocument();

  window.location.hash = "#/workflow";
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  expect(screen.getByRole("heading", { name: "Workflow Viewer" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Project Dashboard" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx`

Expected: FAIL，因为当前 `App` 会同时渲染 Projects、Runs 和所有其他模块。

- [ ] **Step 3: 在 App 中同步 hash，并按路由选择页面**

```tsx
const [currentRoute, setCurrentRoute] = useState(() => normalizeRoute(window.location.hash));

useEffect(() => {
  const handleHashChange = () => setCurrentRoute(normalizeRoute(window.location.hash));
  window.addEventListener("hashchange", handleHashChange);
  return () => window.removeEventListener("hashchange", handleHashChange);
}, []);

useEffect(() => {
  const route = normalizeRoute(window.location.hash);
  if (window.location.hash !== routes.find((item) => item.id === route)?.hash) {
    window.location.replace(routes.find((item) => item.id === route)?.hash ?? "#/projects");
  }
}, []);
```

用 `switch (currentRoute)` 返回 Projects、Runs、Workflow、Terminal、Gates、Artifacts、Approvals、Recovery 或 Settings 的单个模块。把 Runtime 操作表单与 Agent 控制区纳入 Runs 页面。

- [ ] **Step 4: 运行路由测试并确认通过**

Run: `npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx`

Expected: PASS，目标路由内容存在，非目标页面不存在。

### Task 4: 更新现有 Renderer 行为测试

**Files:**
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: 把 Runtime 操作测试的初始地址设为 `#/runs`**

```tsx
window.location.hash = "#/runs";
render(<App />);
```

- [ ] **Step 2: 为每个模块添加路由存在性测试**

```tsx
for (const route of routes) {
  window.location.hash = route.hash;
  const { unmount } = render(<App />);
  expect(screen.getByRole("link", { name: route.label })).toHaveAttribute("aria-current", "page");
  unmount();
}
```

- [ ] **Step 3: 运行完整 Renderer 测试**

Run: `npm.cmd --workspace apps/renderer run test`

Expected: PASS，现有操作测试和新增路由测试均通过。

### Task 5: 完整验证与 Windows 交付

**Files:**
- Modify: 仅前述源文件和测试文件

- [ ] **Step 1: 运行完整回归**

Run: `npm.cmd run verify`

Expected: contracts、renderer、desktop 和 runtime 全部通过。

- [ ] **Step 2: 生成新的完整离线包**

Run: `npm.cmd run package:win:full`

Expected: 生成新的 `release-full-<timestamp>/win-unpacked/AI Workflow Platform.exe` 和 ZIP。

- [ ] **Step 3: 启动 EXE 并检查页面**

Run: 以 `--remote-debugging-port=9222` 启动新 EXE，通过 Chrome DevTools Protocol 验证 `#/projects` 显示项目页，切换到 `#/workflow` 后仅显示工作流页。

- [ ] **Step 4: 提交**

```powershell
git add apps/renderer/src/app apps/renderer/vite.config.ts docs/superpowers/specs/2026-07-28-renderer-independent-routes-design.md docs/superpowers/plans/2026-07-28-renderer-independent-routes.md
git commit -m "feat: add independent renderer routes"
```
