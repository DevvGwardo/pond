import { h } from "preact"
import { useEffect, useRef } from "preact/hooks"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { searchKeymap } from "@codemirror/search"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { oneDark } from "@codemirror/theme-one-dark"
import { languageForPath } from "./api.js"

function languageExtension(path: string): Extension {
  const lang = languageForPath(path)
  if (lang === "typescript") return javascript({ jsx: true, typescript: true })
  if (lang === "json") return json()
  if (lang === "markdown") return markdown()
  return []
}

interface EditorProps {
  path: string
  value: string
  onChange: (next: string) => void
  onSave: () => void
}

export function CodeMirrorEditor(props: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onSaveRef = useRef(props.onSave)
  const onChangeRef = useRef(props.onChange)
  onSaveRef.current = props.onSave
  onChangeRef.current = props.onChange

  // mount + recreate when path changes (so language switches)
  useEffect(() => {
    if (!hostRef.current) return
    const saveBinding = {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        onSaveRef.current()
        return true
      },
    }
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([saveBinding, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.lineWrapping,
        EditorView.theme({
          // `maxHeight: 100%` caps the editor at its host's height so content
          // overflow happens INSIDE `.cm-scroller` (which gets the scrollbar)
          // instead of growing the editor past the host and being clipped by
          // the host's `overflow-hidden` — the previous failure mode that
          // made long files unscrollable in the IDE.
          "&": { height: "100%", maxHeight: "100%", fontSize: "13px" },
          ".cm-scroller": {
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            overflow: "auto",
          },
        }),
        oneDark,
        languageExtension(props.path),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [props.path])

  // sync external value changes (e.g. tab switch back to a clean file)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === props.value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value } })
  }, [props.value])

  return <div class="h-full w-full overflow-hidden" ref={hostRef as any} />
}
