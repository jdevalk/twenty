import { Injectable, Logger } from '@nestjs/common';

import { EntityManager } from 'typeorm';

import { MessageChannelRepository } from 'src/modules/messaging/repositories/message-channel.repository';
import { MessageParticipantRepository } from 'src/modules/messaging/repositories/message-participant.repository';
import { CreateCompanyAndContactService } from 'src/modules/connected-account/auto-companies-and-contacts-creation/create-company-and-contact/create-company-and-contact.service';
import {
  GmailMessage,
  ParticipantWithMessageId,
} from 'src/modules/messaging/types/gmail-message';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';
import { ConnectedAccountObjectMetadata } from 'src/modules/connected-account/standard-objects/connected-account.object-metadata';
import { ObjectRecord } from 'src/engine/workspace-manager/workspace-sync-metadata/types/object-record';
import { InjectObjectMetadataRepository } from 'src/engine/object-metadata-repository/object-metadata-repository.decorator';
import { MessageChannelObjectMetadata } from 'src/modules/messaging/standard-objects/message-channel.object-metadata';
import { MessageService } from 'src/modules/messaging/services/message/message.service';
import { MessageParticipantObjectMetadata } from 'src/modules/messaging/standard-objects/message-participant.object-metadata';
import { MessageParticipantService } from 'src/modules/messaging/services/message-participant/message-participant.service';

@Injectable()
export class SaveMessagesAndCreateContactsService {
  private readonly logger = new Logger(
    SaveMessagesAndCreateContactsService.name,
  );

  constructor(
    private readonly messageService: MessageService,
    @InjectObjectMetadataRepository(MessageChannelObjectMetadata)
    private readonly messageChannelRepository: MessageChannelRepository,
    @InjectObjectMetadataRepository(MessageParticipantObjectMetadata)
    private readonly messageParticipantRepository: MessageParticipantRepository,
    private readonly createCompaniesAndContactsService: CreateCompanyAndContactService,
    private readonly messageParticipantService: MessageParticipantService,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
  ) {}

  async saveMessagesAndCreateContacts(
    messagesToSave: GmailMessage[],
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    workspaceId: string,
    gmailMessageChannelId: string,
    jobName?: string,
  ) {
    const { dataSource: workspaceDataSource, dataSourceMetadata } =
      await this.workspaceDataSourceService.connectedToWorkspaceDataSourceAndReturnMetadata(
        workspaceId,
      );

    let startTime = Date.now();

    const messageExternalIdsAndIdsMap = await this.messageService.saveMessages(
      messagesToSave,
      dataSourceMetadata,
      workspaceDataSource,
      connectedAccount,
      gmailMessageChannelId,
      workspaceId,
    );

    let endTime = Date.now();

    this.logger.log(
      `${jobName} saving messages for workspace ${workspaceId} and account ${
        connectedAccount.id
      } in ${endTime - startTime}ms`,
    );

    const gmailMessageChannel =
      await this.messageChannelRepository.getFirstByConnectedAccountId(
        connectedAccount.id,
        workspaceId,
      );

    if (!gmailMessageChannel) {
      this.logger.error(
        `No message channel found for connected account ${connectedAccount.id} in workspace ${workspaceId} in saveMessagesAndCreateContacts`,
      );

      return;
    }

    const isContactAutoCreationEnabled =
      gmailMessageChannel.isContactAutoCreationEnabled;

    const participantsWithMessageId: ParticipantWithMessageId[] =
      messagesToSave.flatMap((message) => {
        const messageId = messageExternalIdsAndIdsMap.get(message.externalId);

        return messageId
          ? message.participants.map((participant) => ({
              ...participant,
              messageId,
            }))
          : [];
      });

    const contactsToCreate = messagesToSave
      .filter((message) => connectedAccount.handle === message.fromHandle)
      .flatMap((message) => message.participants);

    if (isContactAutoCreationEnabled) {
      startTime = Date.now();

      await workspaceDataSource?.transaction(
        async (transactionManager: EntityManager) => {
          await this.createCompaniesAndContactsService.createCompaniesAndContacts(
            connectedAccount.handle,
            contactsToCreate,
            workspaceId,
            transactionManager,
          );
        },
      );

      const handles = participantsWithMessageId.map(
        (participant) => participant.handle,
      );

      const messageParticipantsWithoutPersonIdAndWorkspaceMemberId =
        await this.messageParticipantRepository.getByHandlesWithoutPersonIdAndWorkspaceMemberId(
          handles,
          workspaceId,
        );

      await this.messageParticipantService.updateMessageParticipantsAfterPeopleCreation(
        messageParticipantsWithoutPersonIdAndWorkspaceMemberId,
        workspaceId,
      );

      endTime = Date.now();

      this.logger.log(
        `${jobName} creating companies and contacts for workspace ${workspaceId} and account ${
          connectedAccount.id
        } in ${endTime - startTime}ms`,
      );
    }

    startTime = Date.now();

    await this.tryToSaveMessageParticipantsOrDeleteMessagesIfError(
      participantsWithMessageId,
      gmailMessageChannelId,
      workspaceId,
      connectedAccount,
      jobName,
    );

    endTime = Date.now();

    this.logger.log(
      `${jobName} saving message participants for workspace ${workspaceId} and account in ${
        connectedAccount.id
      } ${endTime - startTime}ms`,
    );
  }

  private async tryToSaveMessageParticipantsOrDeleteMessagesIfError(
    participantsWithMessageId: ParticipantWithMessageId[],
    gmailMessageChannelId: string,
    workspaceId: string,
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    jobName?: string,
  ) {
    try {
      await this.messageParticipantRepository.saveMessageParticipants(
        participantsWithMessageId,
        workspaceId,
      );
    } catch (error) {
      this.logger.error(
        `${jobName} error saving message participants for workspace ${workspaceId} and account ${connectedAccount.id}`,
        error,
      );

      const messagesToDelete = participantsWithMessageId.map(
        (participant) => participant.messageId,
      );

      await this.messageService.deleteMessages(
        messagesToDelete,
        gmailMessageChannelId,
        workspaceId,
      );
    }
  }
}
