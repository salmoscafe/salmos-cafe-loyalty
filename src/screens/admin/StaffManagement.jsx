import React, { useEffect, useState } from "react";
import { adminService } from "../../services/index.js";
import { Spinner, ErrorState, Field } from "../../components/common/ui.jsx";
import { Icon } from "../../components/common/icons.jsx";

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------
// StaffManagement — ADMIN → Empleados (CHECKPOINT 2).
// Lista empleados (staff), crea cuentas (email + contraseña) y
// activa/desactiva o renombra. En modo real todas las operaciones
// van por la Edge Function segura `admin-employees` (el rol del
// actor es 'admin' + active, verificado server-side).
// ---------------------------------------------------------------
export function StaffManagement() {
  const [employees, setEmployees] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // { type: 'ok'|'error', text }
  const [modal, setModal] = useState(null); // null | { mode:'create' } | { mode:'edit', employee }
  const [busyId, setBusyId] = useState(null);

  function load() {
    setEmployees(null);
    setError(null);
    adminService
      .listEmployees()
      .then((list) => setEmployees(list))
      .catch(() => setError("No pudimos cargar los empleados."));
  }

  useEffect(() => {
    load();
  }, []);

  function showOk(text) {
    setNotice({ type: "ok", text });
  }

  function showError(text) {
    setNotice({ type: "error", text });
  }

  async function handleToggle(employee) {
    setBusyId(employee.id);
    setNotice(null);
    try {
      const target = !employee.active;
      await adminService.setEmployeeActive({ employeeId: employee.id, active: target });
      setEmployees((list) =>
        list.map((e) => (e.id === employee.id ? { ...e, active: target } : e))
      );
      showOk(target ? `${employee.name} quedó activo.` : `${employee.name} quedó desactivado.`);
    } catch (err) {
      showError(err.message || "No pudimos actualizar el empleado.");
    } finally {
      setBusyId(null);
    }
  }

  function handleCreated(employee) {
    setModal(null);
    setEmployees((list) =>
      [employee, ...(list || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), "es"))
    );
    showOk("Empleado creado correctamente.");
  }

  function handleRenamed(employee) {
    setModal(null);
    setEmployees((list) => list.map((e) => (e.id === employee.id ? { ...e, ...employee } : e)));
    showOk("Nombre actualizado.");
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (employees === null) return <Spinner label="Cargando empleados…" />;

  return (
    <div className="sc-admin-screen">
      <div className="sc-admin-employees__head">
        <h1 className="sc-admin-title">Empleados</h1>
        <button className="sc-btn-primary" onClick={() => setModal({ mode: "create" })}>
          + Agregar empleado
        </button>
      </div>

      {notice && (
        <p className={notice.type === "ok" ? "sc-admin-notice sc-admin-notice--ok" : "sc-admin-notice sc-admin-notice--error"}>
          {notice.text}
        </p>
      )}

      {employees.length === 0 ? (
        <div className="sc-admin-empty">
          <p>Todavía no hay empleados. Crea el primero con “+ Agregar empleado”.</p>
        </div>
      ) : (
        <table className="sc-admin-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{e.email || "—"}</td>
                <td>{e.role === "staff" ? "Staff" : e.role}</td>
                <td>
                  <span className={"sc-admin-status" + (e.active ? " sc-admin-status--active" : " sc-admin-status--inactive")}>
                    {e.active ? "● Activo" : "○ Inactivo"}
                  </span>
                </td>
                <td className="sc-admin-actions">
                  <button
                    className="sc-btn-secondary"
                    disabled={busyId === e.id}
                    onClick={() => setModal({ mode: "edit", employee: e })}
                  >
                    Editar
                  </button>
                  <button
                    className="sc-btn-secondary"
                    disabled={busyId === e.id}
                    onClick={() => handleToggle(e)}
                  >
                    {e.active ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <EmployeeForm
          mode={modal.mode}
          employee={modal.employee || null}
          onCancel={() => setModal(null)}
          onCreated={handleCreated}
          onRenamed={handleRenamed}
          onError={showError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// EmployeeForm — modal para crear (nombre/correo/contraseña/rol staff)
// o editar (solo nombre). El rol SIEMPRE es staff en esta pantalla;
// la Edge Function rechaza cualquier role enviado diferente (V1).
// ---------------------------------------------------------------
function EmployeeForm({ mode, employee, onCancel, onCreated, onRenamed, onError }) {
  const isCreate = mode === "create";
  const [name, setName] = useState(employee?.name || "");
  const [email, setEmail] = useState(employee?.email || "");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage(null);

    if (!String(name).trim()) {
      setMessage({ type: "error", text: "El nombre es requerido." });
      return;
    }
    if (isCreate) {
      if (!EMAIL_RE.test(String(email).trim())) {
        setMessage({ type: "error", text: "Escribe un correo válido." });
        return;
      }
      if (String(password).length < MIN_PASSWORD) {
        setMessage({ type: "error", text: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` });
        return;
      }
    }

    setBusy(true);
    try {
      if (isCreate) {
        const created = await adminService.createEmployee({
          email: String(email).trim(),
          password,
          name: String(name).trim(),
        });
        onCreated(created);
      } else {
        const renamed = await adminService.updateEmployee({
          employeeId: employee.id,
          name: String(name).trim(),
        });
        onRenamed(renamed);
      }
    } catch (err) {
      setMessage({ type: "error", text: err.message || "No pudimos guardar los cambios." });
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-admin-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <form
        className="sc-admin-modal"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="sc-admin-subtitle">{isCreate ? "Agregar empleado" : "Editar empleado"}</h2>

        {message && (
          <p className={"sc-admin-notice " + (message.type === "ok" ? "sc-admin-notice--ok" : "sc-admin-notice--error")}>
            {message.text}
          </p>
        )}

        <Field label="Nombre">
          <input
            className="sc-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ana Beltrán"
            autoFocus
          />
        </Field>

        {isCreate && (
          <>
            <Field label="Correo">
              <input
                className="sc-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="empleado@example.com"
              />
            </Field>
            <Field label="Contraseña temporal">
              <input
                className="sc-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`Mínimo ${MIN_PASSWORD} caracteres`}
              />
            </Field>
            <Field label="Rol">
              <div className="sc-admin-modal__role">
                <Icon.User className="sc-icon-sm" />
                <span>Staff</span>
              </div>
            </Field>
          </>
        )}

        <div className="sc-admin-modal__actions">
          <button type="button" className="sc-btn-secondary" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="sc-btn-primary" disabled={busy}>
            {busy ? "Guardando…" : isCreate ? "Crear empleado" : "Guardar"}
          </button>
        </div>
      </form>
    </div>
  );
}