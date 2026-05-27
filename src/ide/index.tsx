import { render, h } from "preact"
import { App } from "./App.js"

const root = document.getElementById("root")
if (root) render(h(App, null), root)
