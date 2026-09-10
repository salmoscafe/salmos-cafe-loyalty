import React from "react";
import { WORDMARK_CREAM, WORDMARK_NAVY, ICON_CREAM, ICON_NAVY } from "../../lib/brandAssets.js";

export function Wordmark({ on = "navy", className }) {
  const src = on === "navy" ? WORDMARK_CREAM : WORDMARK_NAVY;
  return <img src={src} alt="Salmos Café" className={className} />;
}

export function IconMark({ on = "navy", className }) {
  const src = on === "navy" ? ICON_CREAM : ICON_NAVY;
  return <img src={src} alt="" className={className} />;
}
