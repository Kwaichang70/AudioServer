import { useState } from 'react';
import { readTheme, storeTheme, type Theme } from '../../utils/theme.js';

export default function ThemeSection() {
  // The theme is applied at startup (`utils/theme.ts`, R00.2); this section
  // only changes it, so it no longer needs an effect to paint the document.
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  const chooseTheme = (t: Theme) => {
    setTheme(t);
    storeTheme(t);
  };

  const themes: { id: Theme; label: string; desc: string }[] = [
    { id: 'dark', label: 'Dark', desc: 'Default dark theme' },
    { id: 'light', label: 'Light', desc: 'Light backgrounds' },
    { id: 'oled', label: 'OLED', desc: 'Pure black for OLED screens' },
  ];

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Theme</h3>
      <div className="flex gap-3">
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => chooseTheme(t.id)}
            className={`flex-1 p-3 rounded-lg border transition text-center ${
              theme === t.id
                ? 'border-accent bg-accent/10'
                : 'border-white/10 bg-surface-light hover:border-accent/50'
            }`}
          >
            <p className="text-sm font-medium">{t.label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
