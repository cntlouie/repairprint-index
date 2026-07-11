export function SearchBox({ defaultValue = "", compact = false }: { defaultValue?: string; compact?: boolean }) {
  return (
    <form className={compact ? "search-box search-box-compact" : "search-box"} action="/search" method="get">
      <label className="sr-only" htmlFor={compact ? "site-search-compact" : "site-search"}>
        Search by product model, OEM part number, or broken component
      </label>
      <input
        id={compact ? "site-search-compact" : "site-search"}
        name="q"
        type="search"
        minLength={2}
        maxLength={160}
        defaultValue={defaultValue}
        placeholder="Try a model number or OEM part number"
        autoComplete="off"
      />
      <button type="submit">Find a repair</button>
    </form>
  );
}
