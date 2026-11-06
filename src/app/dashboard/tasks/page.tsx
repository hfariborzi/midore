import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { db, places } from "@/db";
import { requireUser } from "@/lib/auth";
import { ensureCategories } from "@/lib/labels";
import { listLinks, listProjects, listTasks } from "@/lib/tasks";
import { TasksBoard } from "./TasksBoard";

export const metadata = { title: "Tasks" };

export default async function TasksPage() {
  const user = await requireUser();
  const [categories, projects, tasks, links, placeList] = await Promise.all([
    ensureCategories(user.id),
    listProjects(user.id),
    listTasks(user.id),
    listLinks(user.id),
    db.select({ id: places.id, name: places.name }).from(places).where(eq(places.userId, user.id)),
  ]);
  const today = DateTime.now().setZone(user.timezone).toISODate()!;
  return (
    <div className="space-y-4">
      <h1 className="sr-only">Tasks</h1>
      <TasksBoard categories={categories} projects={projects} tasks={tasks} links={links} today={today} places={placeList} />
    </div>
  );
}
