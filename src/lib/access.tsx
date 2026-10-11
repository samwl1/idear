import { createContext, useContext } from "react";

/** False in a workspace you can only view (viewer, or removed by its owner). */
export const CanEditContext = createContext(true);

export const useCanEdit = () => useContext(CanEditContext);
