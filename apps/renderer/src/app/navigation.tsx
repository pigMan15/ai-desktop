export const navigationItems = [
  { label: "Projects", href: "#projects" },
  { label: "Runs", href: "#runs" },
  { label: "Workflow", href: "#workflow" },
  { label: "Terminal", href: "#terminal" },
  { label: "Gates", href: "#gates" },
  { label: "Artifacts", href: "#artifacts" },
  { label: "Approvals", href: "#approvals" },
  { label: "Recovery", href: "#recovery" },
  { label: "Settings", href: "#settings" },
];

export function Navigation() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <p className="product-kicker">AI Workflow</p>
        <p className="product-name">工作台</p>
      </div>
      <nav aria-label="主导航" className="nav-list">
        {navigationItems.map((item) => (
          <a href={item.href} key={item.href} className="nav-link">
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}
