import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/review", label: "Review Queue" },
  { to: "/orders", label: "All Purchase Orders" },
  { to: "/crises", label: "Active Crises" },
];

export default function Layout() {
  const { user, role, signOut } = useAuth();
  const nav = useNavigate();

  async function handleSignOut() {
    await signOut();
    nav("/login", { replace: true });
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-60 bg-slate-900 text-slate-100 flex flex-col">
        <div className="p-5 border-b border-slate-800">
          <div className="text-lg font-semibold">OFAEM</div>
          <div className="text-xs text-slate-400">Order Fulfillment Engine</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-md text-sm transition ${
                  isActive
                    ? "bg-slate-700 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`
              }
            >
              {it.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-800 text-xs text-slate-400">
          <div className="truncate font-medium text-slate-200">{user?.email}</div>
          <div className="mt-0.5">Role: {role ?? "—"}</div>
          <button
            onClick={handleSignOut}
            className="mt-3 w-full text-left text-slate-300 hover:text-white"
          >
            Sign out →
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
