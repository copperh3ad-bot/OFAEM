import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import Login from "./pages/Login";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import ReviewQueue from "./pages/ReviewQueue";
import AllOrders from "./pages/AllOrders";
import PODetail from "./pages/PODetail";
import Crises from "./pages/Crises";

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="review" element={<ReviewQueue />} />
            <Route path="orders" element={<AllOrders />} />
            <Route path="orders/:id" element={<PODetail />} />
            <Route path="crises" element={<Crises />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
