import { createContext, useEffect, useState } from "react";

const Context = createContext(null);
export function Scene({ selected }: { selected: string }) {
  const [frame, setFrame] = useState(0);
  const [selection, setSelection] = useState(selected);
  const apiClient = {};
  const publish = () => setFrame(frame + 1);
  requestAnimationFrame(() => publish());
  useEffect(() => { setSelection(selected); }, [selected]);
  return <Context.Provider value={{ frame, setFrame, apiClient }}>{selection}</Context.Provider>;
}
