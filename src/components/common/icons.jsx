import React from "react";

export const Icon = {
  Home: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3v-5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20h3a1 1 0 0 0 1-1v-9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Gift: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="4" y="9.5" width="16" height="10.5" rx="1.3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9.5h16v3.2H4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9.5V20" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 9.5c-1.4 0-4-1-4-3.2C8 4.6 9.1 4 9.9 4c1.5 0 2.1 2 2.1 5.5Zm0 0c1.4 0 4-1 4-3.2C16 4.6 14.9 4 14.1 4c-1.5 0-2.1 2-2.1 5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  Activity: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 12h3l2 6 4-14 2 8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  User: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="8.3" r="3.3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  QR: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14.5 14.5h2.7v2.7h-2.7zM19.5 14.5h1v1h-1zM14.5 19.5h1v1h-1zM17.7 17.7h2.8v2.8h-2.8z" fill="currentColor" />
    </svg>
  ),
  Check: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 12.3l2.6 2.6L16.2 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Cup: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M5 8h11v6.2A4.8 4.8 0 0 1 11.2 19H9.8A4.8 4.8 0 0 1 5 14.2V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M16 9.3h1.4a2.3 2.3 0 0 1 0 4.6H16" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 5.2c-.6.7-.6 1.3 0 2M11 5.2c-.6.7-.6 1.3 0 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Receipt: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3v-17Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Scan: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  ArrowLeft: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M11 5 4 12l7 7M4 12h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronRight: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Download: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  Mail: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4 7 8 5.5L20 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Sparkle: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    </svg>
  ),
  Search: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m20 20-4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Wallet: (p) => (
    <svg viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3.5" y="6" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="14" r="1.1" fill="currentColor" />
    </svg>
  ),
  Google: (p) => (
    <svg viewBox="0 0 48 48" {...p}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  ),
};
