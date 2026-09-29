import { useEffect, useRef, useState } from "react";

export function Scene({ selected }: { selected: string }) {
  const renderer = useRef({ frame: 0 });
  const [time, setTime] = useState(0);
  requestAnimationFrame(() => { renderer.current.frame += 1; });
  useEffect(() => {
    const video = document.querySelector("video");
    if (!video) return;
    const sync = () => setTime(video.currentTime);
    video.addEventListener("timeupdate", sync);
    return () => video.removeEventListener("timeupdate", sync);
  }, []);
  useEffect(() => { document.title = selected; }, [selected]);
  return <output>{time}</output>;
}
