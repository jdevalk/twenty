import { useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';

import { useGetCurrentView } from '@/views/hooks/useGetCurrentView';
import { useGetAvailableFieldsForKanban } from '@/views/view-picker/hooks/useGetAvailableFieldsForKanban';
import { useViewPickerStates } from '@/views/view-picker/hooks/useViewPickerStates';
import { isDefined } from '~/utils/isDefined';

export const ViewPickerCreateOrEditContentEffect = () => {
  const {
    viewPickerSelectedIconState,
    viewPickerInputNameState,
    viewPickerReferenceViewIdState,
    viewPickerIsPersistingState,
    viewPickerKanbanFieldMetadataIdState,
    viewPickerTypeState,
  } = useViewPickerStates();

  const setViewPickerSelectedIcon = useSetRecoilState(
    viewPickerSelectedIconState,
  );
  const setViewPickerInputName = useSetRecoilState(viewPickerInputNameState);

  const setViewPickerKanbanFieldMetadataId = useSetRecoilState(
    viewPickerKanbanFieldMetadataIdState,
  );
  const setViewPickerType = useSetRecoilState(viewPickerTypeState);

  const viewPickerReferenceViewId = useRecoilValue(
    viewPickerReferenceViewIdState,
  );

  const viewPickerIsPersisting = useRecoilValue(viewPickerIsPersistingState);

  const { viewsOnCurrentObject } = useGetCurrentView();
  const editedView = viewsOnCurrentObject.find(
    (view) => view.id === viewPickerReferenceViewId,
  );

  const { availableFieldsForKanban } = useGetAvailableFieldsForKanban();

  useEffect(() => {
    if (isDefined(editedView) && !viewPickerIsPersisting) {
      setViewPickerSelectedIcon(editedView.icon);
      setViewPickerInputName(editedView.name);
      setViewPickerKanbanFieldMetadataId(editedView.kanbanFieldMetadataId);
      setViewPickerType(editedView.type);
    }
  }, [
    editedView,
    setViewPickerInputName,
    setViewPickerKanbanFieldMetadataId,
    setViewPickerSelectedIcon,
    setViewPickerType,
    viewPickerIsPersisting,
  ]);

  useEffect(() => {
    if (availableFieldsForKanban.length > 0) {
      setViewPickerKanbanFieldMetadataId(availableFieldsForKanban[0].id);
    }
  }, [availableFieldsForKanban, setViewPickerKanbanFieldMetadataId]);

  return <></>;
};
