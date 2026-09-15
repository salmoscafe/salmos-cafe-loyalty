import React from "react";
import { getDailyPassage } from "../../lib/psalms.js";

export function DailyVerse({ date }) {
  const passage = getDailyPassage(date ?? new Date());

  return (
    <section className="sc-daily-verse" aria-label="Salmos de hoy">
      <p className="sc-daily-verse__eyebrow">Salmos de hoy</p>
      <p className="sc-daily-verse__text">{passage.text}</p>
      <p className="sc-daily-verse__reference">{passage.reference}</p>
      <div className="sc-daily-verse__meta">
        <ul className="sc-daily-verse__tags">
          {passage.tags.map((tag) => (
            <li key={tag} className="sc-daily-verse__tag">{tag}</li>
          ))}
        </ul>
        <span className="sc-daily-verse__source">RVR1960</span>
      </div>
    </section>
  );
}