import { routes, type RouteId } from "./routes";

export function Navigation({ currentRoute }: { currentRoute: RouteId }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <p className="product-kicker">AI Workflow</p>
        <p className="product-name">工作台</p>
      </div>
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
