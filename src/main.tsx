import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";

document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
