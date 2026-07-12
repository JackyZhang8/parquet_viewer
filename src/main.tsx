import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>Parquet Viewer</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
