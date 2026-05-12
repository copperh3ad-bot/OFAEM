import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Login() {
  const { signInWithPassword } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error } = await signInWithPassword(email, password);
    setBusy(false);
    if (error) setError(error);
    else nav("/", { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white shadow-md rounded-lg p-8 space-y-4"
      >
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">OFAEM Review</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to review purchase orders</p>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </label>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium py-2 rounded-md transition"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-xs text-slate-400 text-center pt-2">
          User must be provisioned in Supabase Auth with a row in <code>user_profiles</code>.
        </p>
      </form>
    </div>
  );
}
