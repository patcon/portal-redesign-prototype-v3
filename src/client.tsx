import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { navigate } from "./router";
import { useRoute } from "./hooks/useRoute";
import { GroupView } from "./components/GroupView";
import { HostView } from "./components/HostView";
import { JoinView } from "./components/JoinView";
import "./styles.css";

function App() {
  const route = useRoute();

  // No route: start a fresh event and send the host to its console.
  useEffect(() => {
    if (route) return;
    navigate({ name: "host", eventId: crypto.randomUUID().slice(0, 8) });
  }, [route]);

  if (!route) return null;
  switch (route.name) {
    case "host":
      return <HostView eventId={route.eventId} />;
    case "join":
      return <JoinView eventId={route.eventId} />;
    case "group":
      return <GroupView eventId={route.eventId} chatId={route.chatId} />;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
