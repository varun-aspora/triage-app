import { LinkButton } from '../components/Button.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { Panel } from '../components/Panel.tsx';

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Panel padded={false}>
        <EmptyState title="There is nothing at this address" actions={<LinkButton to="/runs" variant="primary">Go to runs</LinkButton>}>
          Check the link, or pick a page from the sidebar.
        </EmptyState>
      </Panel>
    </>
  );
}
