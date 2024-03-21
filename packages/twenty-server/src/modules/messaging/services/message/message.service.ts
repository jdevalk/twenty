import { Injectable, Logger } from '@nestjs/common';

import { DataSource, EntityManager } from 'typeorm';
import { v4 } from 'uuid';

import { DataSourceEntity } from 'src/engine-metadata/data-source/data-source.entity';
import { InjectObjectMetadataRepository } from 'src/engine/object-metadata-repository/object-metadata-repository.decorator';
import { ObjectRecord } from 'src/engine/workspace-manager/workspace-sync-metadata/types/object-record';
import { ConnectedAccountObjectMetadata } from 'src/modules/connected-account/standard-objects/connected-account.object-metadata';
import { MessageChannelMessageAssociationRepository } from 'src/modules/messaging/repositories/message-channel-message-association.repository';
import { MessageRepository } from 'src/modules/messaging/repositories/message.repository';
import { MessageChannelMessageAssociationObjectMetadata } from 'src/modules/messaging/standard-objects/message-channel-message-association.object-metadata';
import { MessageObjectMetadata } from 'src/modules/messaging/standard-objects/message.object-metadata';
import { GmailMessage } from 'src/modules/messaging/types/gmail-message';
import { MessageChannelObjectMetadata } from 'src/modules/messaging/standard-objects/message-channel.object-metadata';
import { MessageChannelRepository } from 'src/modules/messaging/repositories/message-channel.repository';
import { MessageThreadService } from 'src/modules/messaging/services/message-thread/message-thread.service';
import { MessageThreadObjectMetadata } from 'src/modules/messaging/standard-objects/message-thread.object-metadata';
import { MessageThreadRepository } from 'src/modules/messaging/repositories/message-thread.repository';
import { WorkspaceDataSourceService } from 'src/engine/workspace-datasource/workspace-datasource.service';

@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
    @InjectObjectMetadataRepository(
      MessageChannelMessageAssociationObjectMetadata,
    )
    private readonly messageChannelMessageAssociationRepository: MessageChannelMessageAssociationRepository,
    @InjectObjectMetadataRepository(MessageObjectMetadata)
    private readonly messageRepository: MessageRepository,
    @InjectObjectMetadataRepository(MessageChannelObjectMetadata)
    private readonly messageChannelRepository: MessageChannelRepository,
    @InjectObjectMetadataRepository(MessageThreadObjectMetadata)
    private readonly messageThreadRepository: MessageThreadRepository,
    private readonly messageThreadService: MessageThreadService,
  ) {}

  // This is temporary and should replace saveMessages
  public async saveMessagesFromCache(
    messages: GmailMessage[],
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    gmailMessageChannelId: string,
    workspaceId: string,
  ): Promise<Map<string, string>> {
    const { dataSource: workspaceDataSource, dataSourceMetadata } =
      await this.workspaceDataSourceService.connectedToWorkspaceDataSourceAndReturnMetadata(
        workspaceId,
      );

    return await this.saveMessages(
      messages,
      dataSourceMetadata,
      workspaceDataSource,
      connectedAccount,
      gmailMessageChannelId,
      workspaceId,
    );
  }

  public async saveMessages(
    messages: GmailMessage[],
    dataSourceMetadata: DataSourceEntity,
    workspaceDataSource: DataSource,
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    gmailMessageChannelId: string,
    workspaceId: string,
  ): Promise<Map<string, string>> {
    const messageExternalIdsAndIdsMap = new Map<string, string>();

    try {
      let keepImporting = true;

      for (const message of messages) {
        if (!keepImporting) {
          break;
        }

        await workspaceDataSource?.transaction(
          async (manager: EntityManager) => {
            const gmailMessageChannel =
              await this.messageChannelRepository.getByIds(
                [gmailMessageChannelId],
                workspaceId,
                manager,
              );

            if (gmailMessageChannel.length === 0) {
              this.logger.error(
                `No message channel found for connected account ${connectedAccount.id} in workspace ${workspaceId} in saveMessages`,
              );

              keepImporting = false;

              return;
            }

            const existingMessageChannelMessageAssociationsCount =
              await this.messageChannelMessageAssociationRepository.countByMessageExternalIdsAndMessageChannelId(
                [message.externalId],
                gmailMessageChannelId,
                workspaceId,
                manager,
              );

            if (existingMessageChannelMessageAssociationsCount > 0) {
              return;
            }

            // TODO: This does not handle all thread merging use cases and might create orphan threads.
            const savedOrExistingMessageThreadId =
              await this.messageThreadService.saveMessageThreadOrReturnExistingMessageThread(
                message.headerMessageId,
                message.messageThreadExternalId,
                workspaceId,
                manager,
              );

            const savedOrExistingMessageId =
              await this.saveMessageOrReturnExistingMessage(
                message,
                savedOrExistingMessageThreadId,
                connectedAccount,
                dataSourceMetadata,
                workspaceId,
                manager,
              );

            messageExternalIdsAndIdsMap.set(
              message.externalId,
              savedOrExistingMessageId,
            );

            await this.messageChannelMessageAssociationRepository.insert(
              gmailMessageChannelId,
              savedOrExistingMessageId,
              message.externalId,
              savedOrExistingMessageThreadId,
              message.messageThreadExternalId,
              workspaceId,
              manager,
            );
          },
        );
      }
    } catch (error) {
      throw new Error(
        `Error saving connected account ${connectedAccount.id} messages to workspace ${workspaceId}: ${error.message}`,
      );
    }

    return messageExternalIdsAndIdsMap;
  }

  private async saveMessageOrReturnExistingMessage(
    message: GmailMessage,
    messageThreadId: string,
    connectedAccount: ObjectRecord<ConnectedAccountObjectMetadata>,
    dataSourceMetadata: DataSourceEntity,
    workspaceId: string,
    manager: EntityManager,
  ): Promise<string> {
    const existingMessage =
      await this.messageRepository.getFirstOrNullByHeaderMessageId(
        message.headerMessageId,
        workspaceId,
      );
    const existingMessageId = existingMessage?.id;

    if (existingMessageId) {
      return Promise.resolve(existingMessageId);
    }

    const newMessageId = v4();

    const messageDirection =
      connectedAccount.handle === message.fromHandle ? 'outgoing' : 'incoming';

    const receivedAt = new Date(parseInt(message.internalDate));

    await this.messageRepository.insert(
      newMessageId,
      message.headerMessageId,
      message.subject,
      receivedAt,
      messageDirection,
      messageThreadId,
      message.text,
      workspaceId,
      manager,
    );

    return Promise.resolve(newMessageId);
  }

  public async deleteMessages(
    messagesDeletedMessageExternalIds: string[],
    gmailMessageChannelId: string,
    workspaceId: string,
  ) {
    const workspaceDataSource =
      await this.workspaceDataSourceService.connectToWorkspaceDataSource(
        workspaceId,
      );

    await workspaceDataSource?.transaction(async (manager: EntityManager) => {
      const messageChannelMessageAssociationsToDelete =
        await this.messageChannelMessageAssociationRepository.getByMessageExternalIdsAndMessageChannelId(
          messagesDeletedMessageExternalIds,
          gmailMessageChannelId,
          workspaceId,
          manager,
        );

      const messageChannelMessageAssociationIdsToDeleteIds =
        messageChannelMessageAssociationsToDelete.map(
          (messageChannelMessageAssociationToDelete) =>
            messageChannelMessageAssociationToDelete.id,
        );

      await this.messageChannelMessageAssociationRepository.deleteByIds(
        messageChannelMessageAssociationIdsToDeleteIds,
        workspaceId,
        manager,
      );

      const messageIdsFromMessageChannelMessageAssociationsToDelete =
        messageChannelMessageAssociationsToDelete.map(
          (messageChannelMessageAssociationToDelete) =>
            messageChannelMessageAssociationToDelete.messageId,
        );

      const messageChannelMessageAssociationByMessageIds =
        await this.messageChannelMessageAssociationRepository.getByMessageIds(
          messageIdsFromMessageChannelMessageAssociationsToDelete,
          workspaceId,
          manager,
        );

      const messageIdsFromMessageChannelMessageAssociationByMessageIds =
        messageChannelMessageAssociationByMessageIds.map(
          (messageChannelMessageAssociation) =>
            messageChannelMessageAssociation.messageId,
        );

      const messageIdsToDelete =
        messageIdsFromMessageChannelMessageAssociationsToDelete.filter(
          (messageId) =>
            !messageIdsFromMessageChannelMessageAssociationByMessageIds.includes(
              messageId,
            ),
        );

      await this.messageRepository.deleteByIds(
        messageIdsToDelete,
        workspaceId,
        manager,
      );

      const messageThreadIdsFromMessageChannelMessageAssociationsToDelete =
        messageChannelMessageAssociationsToDelete.map(
          (messageChannelMessageAssociationToDelete) =>
            messageChannelMessageAssociationToDelete.messageThreadId,
        );

      const messagesByThreadIds =
        await this.messageRepository.getByMessageThreadIds(
          messageThreadIdsFromMessageChannelMessageAssociationsToDelete,
          workspaceId,
          manager,
        );

      const threadIdsToDelete =
        messageThreadIdsFromMessageChannelMessageAssociationsToDelete.filter(
          (threadId) =>
            !messagesByThreadIds.find(
              (message) => message.messageThreadId === threadId,
            ),
        );

      await this.messageThreadRepository.deleteByIds(
        threadIdsToDelete,
        workspaceId,
        manager,
      );
    });
  }
}
