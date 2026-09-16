import React, { useEffect, useState } from "react";
import "./styles.css";
import { resolveAppMode } from "./lib/navigation.js";

import { authService, salesService, ManualSalesAdapter } from "./services/index.js";
import { getCardForCustomer } from "./services/index.js";
import { rewardService } from "./services/index.js";

import { Wordmark, IconMark } from "./components/common/BrandMark.jsx";
import { BottomNav } from "./components/layout/BottomNav.jsx";
import { QrModal } from "./components/layout/QrModal.jsx";
import { Spinner } from "./components/common/ui.jsx";

import { AuthScreen } from "./components/auth/AuthScreen.jsx";
import { RoleLoginScreen } from "./components/auth/RoleLoginScreen.jsx";
import { HomeScreen } from "./screens/client/Home.jsx";
import { RewardsScreen } from "./screens/client/Rewards.jsx";
import { ActivityScreen } from "./screens/client/Activity.jsx";
import { ProfileScreen } from "./screens/client/Profile.jsx";
import { SettingsScreen } from "./screens/client/Settings.jsx";

import { StaffLoginScreen } from "./screens/staff/StaffLogin.jsx";
import { StaffHomeScreen } from "./screens/staff/StaffHome.jsx";
import { ScannerScreen } from "./screens/staff/Scanner.jsx";
import { CustomerFoundScreen } from "./screens/staff/CustomerFound.jsx";
import { RegisterSaleScreen } from "./screens/staff/RegisterSale.jsx";
import { ConfirmationScreen } from "./screens/staff/Confirmation.jsx";
import { StaffActivityScreen } from "./screens/staff/StaffActivity.jsx";

import { AdminDashboard } from "./screens/admin/Dashboard.jsx";
import { AdminCustomers } from "./screens/admin/Customers.jsx";
import { StaffManagement } from "./screens/admin/StaffManagement.jsx";
import { ComingSoon } from "./screens/admin/ComingSoon.jsx";

/* =========================================================
   Root — Cliente / Staff / Admin son tres experiencias
   separadas por pathname (sin router):
     /        → Cliente    /Staff → Staff    /Admin → Admin
   En producción cada una vive en un despliegue/dominio o guard
   de auth propio; la resolución aquí es solo de navegación.
   ========================================================= */
export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onNavigate = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onNavigate);
    return () => window.removeEventListener("popstate", onNavigate);
  }, []);

  const appMode = resolveAppMode(path);

  return (
    <div className="sc-root">
      <div className="sc-ambient" aria-hidden="true" />

      {appMode === "client" && <ClientApp />}
      {appMode === "staff" && <StaffApp />}
      {appMode === "admin" && <AdminApp />}
    </div>
  );
}

/* --------------------------- Cliente --------------------------- */

function ClientApp() {
  const [session, setSession] = useState(undefined); // undefined = cargando
  const [screen, setScreen] = useState("home");
  const [loyalty, setLoyalty] = useState({ card: null, cycle: null, currentReward: null, loading: true, error: null });
  const [qr, setQr] = useState({ open: false, mode: "show" });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    authService.getSession().then((s) => setSession(s));
    const unsubscribe = authService.onSessionChange(() => {
      authService.getSession().then((s) => setSession(s));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoyalty((s) => ({ ...s, loading: true, error: null }));
    getCardForCustomer(session.customer.profileId || session.customer.id)
      .then(async ({ card, cycle }) => {
        if (cancelled) return;
        const currentReward = card ? await rewardService.getCurrentReward(card.id) : null;
        if (cancelled) return;
        setLoyalty({ card, cycle, currentReward, loading: false, error: null });
      })
      .catch(() => !cancelled && setLoyalty((s) => ({ ...s, loading: false, error: "No pudimos cargar tu tarjeta." })));
    return () => {
      cancelled = true;
    };
  }, [session, refreshTick]);

  if (session === undefined) {
    return (
      <div className="sc-phone">
        <div className="sc-main"><Spinner label="Cargando…" /></div>
      </div>
    );
  }

  if (session === null) {
    return (
      <div className="sc-phone">
        <div className="sc-main">
          <AuthScreen
            onSignedIn={() =>
              authService.getSession().then((s) => {
                if (s) setSession(s);
                return s;
              })
            }
          />
        </div>
      </div>
    );
  }

  const { customer } = session;

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  async function handleRetrySync() {
    const res = await authService.retryLoyverseSync();
    if (res.ok) {
      const s = await authService.getSession();
      setSession(s);
    }
    return res;
  }

  async function handleSignOut() {
    await authService.signOutClient();
    setSession(null);
    setScreen("home");
  }

  return (
    <div className="sc-phone">
      <header className="sc-topbar">
        <IconMark on="cream" className="sc-topbar__mark" />
        <span className="sc-topbar__name">Salmos Café</span>
      </header>

      <main className="sc-main">
        {screen === "home" && (
          <HomeScreen
            customer={customer}
            card={loyalty.card}
            cycle={loyalty.cycle}
            currentReward={loyalty.currentReward}
            loading={loyalty.loading}
            error={loyalty.error}
            onRetry={refresh}
            onRetrySync={handleRetrySync}
            onOpenQr={(mode) => setQr({ open: true, mode })}
          />
        )}
        {screen === "rewards" && !loyalty.loading && loyalty.card && (
          <RewardsScreen card={loyalty.card} cycle={loyalty.cycle} currentReward={loyalty.currentReward} />
        )}
        {screen === "activity" && !loyalty.loading && loyalty.card && (
          <ActivityScreen customer={customer} card={loyalty.card} />
        )}
        {screen === "profile" && !loyalty.loading && loyalty.card && (
          <ProfileScreen
            customer={customer}
            card={loyalty.card}
            onRetrySync={handleRetrySync}
            onOpenSettings={() => setScreen("settings")}
            onSignOut={handleSignOut}
          />
        )}
        {screen === "settings" && <SettingsScreen onBack={() => setScreen("profile")} />}
      </main>

      {screen !== "settings" && (
        <BottomNav screen={screen} onNavigate={(s) => { setScreen(s); if (s === "home") refresh(); }} onQr={() => setQr({ open: true, mode: "show" })} />
      )}

      {loyalty.card && (
        <QrModal
          open={qr.open}
          mode={qr.mode}
          onClose={() => setQr({ open: false, mode: "show" })}
          cardNumber={loyalty.card.cardNumber}
          customerName={customer.name}
        />
      )}
    </div>
  );
}

/* --------------------------- Staff --------------------------- */

function StaffApp() {
  const [staffSession, setStaffSession] = useState(undefined);
  const [screen, setScreen] = useState("home");
  const [found, setFound] = useState(null); // resultado del lookup (customer/cycle/progress/reward; +card en demo)
  const [saleResult, setSaleResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    authService.getProfile().then((profile) => {
      if (cancelled) return;
      if (profile && profile.active && profile.role === "staff") {
        setStaffSession({ staff: { id: profile.id, name: profile.name || "Equipo", role: profile.role } });
      } else {
        setStaffSession(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (staffSession === undefined) {
    return (
      <div className="sc-phone">
        <div className="sc-main"><Spinner label="Cargando…" /></div>
      </div>
    );
  }

  if (staffSession === null) {
    return (
      <div className="sc-phone">
        <div className="sc-main"><StaffLoginScreen onSignedIn={(identity) => setStaffSession({ staff: identity })} /></div>
      </div>
    );
  }

  const { staff } = staffSession;

  async function handleSignOut() {
    if (authService.isDemoMode) {
      await authService.signOutStaff();
    } else {
      await authService.signOutClient();
    }
    setStaffSession(null);
    setScreen("home");
    setFound(null);
  }

  async function handleSubmitSale({ amount, paymentMethod, branchId }) {
    const normalized = ManualSalesAdapter.normalizeSale({
      customerId: found.customer.id,
      cardId: found.card.id,
      branchId,
      amount,
      paymentMethod,
      employeeId: staff.id,
    });
    const res = await salesService.registerSale(normalized);
    if (res.ok) {
      setSaleResult(res);
      setScreen("confirmation");
    }
    return res;
  }

  return (
    <div className="sc-phone">
      <header className="sc-topbar">
        <IconMark on="cream" className="sc-topbar__mark" />
        <span className="sc-topbar__name">Salmos Café · Equipo</span>
      </header>

      <main className="sc-main">
        {screen === "home" && (
          <StaffHomeScreen
            staff={staff}
            onScan={() => setScreen("scanner")}
            onActivity={() => setScreen("activity")}
            onSignOut={handleSignOut}
          />
        )}

        {screen === "scanner" && (
          <ScannerScreen
            onBack={() => setScreen("home")}
            onFound={(res) => {
              setFound(res);
              setScreen("found");
            }}
          />
        )}

        {screen === "found" && found && (
          <CustomerFoundScreen
            result={found}
            staff={staff}
            onBack={() => setScreen("scanner")}
            onRegisterSale={() => setScreen("sale")}
            onRedeemed={({ newCycle }) => setFound((f) => ({ ...f, cycle: newCycle }))}
          />
        )}

        {screen === "sale" && found && (
          <RegisterSaleScreen
            customer={found.customer}
            card={found.card}
            onBack={() => setScreen("found")}
            onSubmit={handleSubmitSale}
          />
        )}

        {screen === "confirmation" && saleResult && found && (
          <ConfirmationScreen
            customer={found.customer}
            sale={saleResult.sale}
            cycle={saleResult.cycle}
            newReward={saleResult.newReward}
            onRegisterAnother={() => setScreen("scanner")}
            onDone={() => {
              setFound(null);
              setSaleResult(null);
              setScreen("home");
            }}
          />
        )}

        {screen === "activity" && <StaffActivityScreen staff={staff} onBack={() => setScreen("home")} />}
      </main>
    </div>
  );
}

/* --------------------------- Admin --------------------------- */

function AdminApp() {
  const [adminSession, setAdminSession] = useState(undefined);
  const [tab, setTab] = useState("dashboard");
  const TABS = [
    { key: "dashboard", label: "Dashboard" },
    { key: "customers", label: "Clientes" },
    { key: "sales", label: "Ventas" },
    { key: "rewards", label: "Recompensas" },
    { key: "staff", label: "Empleados" },
    { key: "settings", label: "Configuración" },
  ];

  useEffect(() => {
    let cancelled = false;
    authService.getProfile().then((profile) => {
      if (cancelled) return;
      if (profile && profile.active && profile.role === "admin") {
        setAdminSession({ admin: { id: profile.id, name: profile.name || "Admin", role: profile.role } });
      } else {
        setAdminSession(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (adminSession === undefined) {
    return (
      <div className="sc-phone">
        <div className="sc-main"><Spinner label="Cargando…" /></div>
      </div>
    );
  }

  if (adminSession === null) {
    return (
      <div className="sc-phone">
        <div className="sc-main">
          <RoleLoginScreen
            requiredRole="admin"
            title="Acceso administrativo"
            subtitle="Ingresa tus datos de administración."
            demoHint="Demo: PIN 9999 (Diana · Admin)"
            onSignedIn={(identity) => setAdminSession({ admin: identity })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="sc-admin-shell">
      <aside className="sc-admin-sidebar">
        <div className="sc-admin-sidebar__brand">
          <Wordmark on="navy" className="sc-admin-sidebar__wordmark" />
        </div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={"sc-admin-sidebar__item" + (tab === t.key ? " sc-admin-sidebar__item--active" : "")}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="sc-admin-main">
        {tab === "dashboard" && <AdminDashboard />}
        {tab === "customers" && <AdminCustomers />}
        {tab === "sales" && <ComingSoon title="Ventas" />}
        {tab === "rewards" && <ComingSoon title="Recompensas" />}
        {tab === "staff" && <StaffManagement />}
        {tab === "settings" && <ComingSoon title="Configuración" />}
      </main>
      <button
        className="sc-admin-signout"
        onClick={async () => {
          if (authService.isDemoMode) await authService.signOutStaff();
          else await authService.signOutClient();
          setAdminSession(null);
        }}
      >
        Cerrar sesión
      </button>
    </div>
  );
}
