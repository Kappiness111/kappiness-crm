"use client";

import CalendarTimeGrid from "./CalendarTimeGrid";
import { startOfDay } from "../../lib/calendar";

export default function CalendarDayView({ anchor, ...rest }) {
  return <CalendarTimeGrid days={[startOfDay(anchor)]} {...rest} />;
}