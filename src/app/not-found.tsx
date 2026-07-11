import Link from "next/link";

export default function NotFound() {
  return <div className="shell page-shell empty-state"><h1>That record is not in the index</h1><p>Check the exact model suffix or request a missing part.</p><Link className="button-primary" href="/search">Search again</Link></div>;
}
