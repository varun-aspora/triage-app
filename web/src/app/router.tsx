// Route table. Pages live in pages/<area>/ and each default-exports one component.

import { createBrowserRouter, Navigate } from 'react-router';
import AddServicePage from '../pages/catalog/AddServicePage.tsx';
import GuidePage from '../pages/catalog/GuidePage.tsx';
import GuidesPage from '../pages/catalog/GuidesPage.tsx';
import NewGuidePage from '../pages/catalog/NewGuidePage.tsx';
import ServicesPage from '../pages/catalog/ServicesPage.tsx';
import DoctorPage from '../pages/ops/DoctorPage.tsx';
import ReposPage from '../pages/ops/ReposPage.tsx';
import NewRunPage from '../pages/runs/NewRunPage.tsx';
import RunDetailPage from '../pages/runs/RunDetailPage.tsx';
import RunsListPage from '../pages/runs/RunsListPage.tsx';
import NotFound from './NotFound.tsx';
import { Shell } from './Shell.tsx';

/** Must match the server's UI_PREFIX and Vite's base. */
export const BASENAME = '/ui';

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <Shell />,
      children: [
        { index: true, element: <Navigate to="/runs" replace /> },
        { path: 'runs', element: <RunsListPage /> },
        { path: 'runs/new', element: <NewRunPage /> },
        { path: 'runs/:runId', element: <RunDetailPage /> },
        { path: 'services', element: <ServicesPage /> },
        { path: 'services/new', element: <AddServicePage /> },
        { path: 'guides', element: <GuidesPage /> },
        { path: 'guides/new', element: <NewGuidePage /> },
        { path: 'guides/:name', element: <GuidePage /> },
        { path: 'repos', element: <ReposPage /> },
        { path: 'doctor', element: <DoctorPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: BASENAME },
);
