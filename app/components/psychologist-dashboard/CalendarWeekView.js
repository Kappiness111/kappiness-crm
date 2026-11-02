"use client";

import CalendarTimeGrid from "./CalendarTimeGrid";
import { weekDays } from "../../lib/calendar";

export default function CalendarWeekView({ anchor, ...rest }) {
  return <CalendarTimeGrid days={weekDays(anchor)} {...rest} />;
}