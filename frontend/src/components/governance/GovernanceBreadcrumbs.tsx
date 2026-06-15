/**
 * Shared breadcrumb component for governance sub-pages.
 *
 * Renders 'Governance / <Page Title>' at the top of every
 * /governance/* sub-page. The 'Governance' segment is a plain anchor
 * pointing at /governance — not a react-router-dom Link — so the
 * component renders without a Router context (which means tests don't
 * need a MemoryRouter wrapper). Click is a regular browser navigation
 * to the overview, which is effectively a hard navigation anyway.
 *
 * Built on the shadcn Breadcrumb primitive so the visual aesthetic
 * matches the rest of the app.
 */
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../ui/breadcrumb';

export interface GovernanceBreadcrumbsProps {
  /** Title of the current sub-page. Rendered as the trailing
   * BreadcrumbPage segment, e.g. 'Rollout readiness'. */
  title: string;
}

export function GovernanceBreadcrumbs({ title }: GovernanceBreadcrumbsProps) {
  return (
    <Breadcrumb className="mb-4" data-testid="governance-breadcrumbs">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/governance">Governance</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
