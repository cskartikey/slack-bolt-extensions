/* eslint-disable no-param-reassign */
/* eslint-disable node/no-extraneous-import */
/* eslint-disable import/no-extraneous-dependencies */
import 'reflect-metadata';

import {
  Installation,
  InstallationQuery,
  InstallationStore,
  Logger,
} from '@slack/oauth';

import { Connection, EntityTarget } from 'typeorm';
// eslint-disable-next-line import/no-internal-modules
import InstallationEntity from './InstallationEntity';
import TypeORMInstallationStoreArgs from './TypeORMInstallationStoreArgs';

export default class TypeORMInstallationStore implements InstallationStore {
  private connection: Connection;

  private clientId?: string;

  private historicalDataEnabled: boolean;

  private entityFactory: () => InstallationEntity;

  private entityTarget: EntityTarget<InstallationEntity>;

  public constructor(options: TypeORMInstallationStoreArgs) {
    this.clientId = options.clientId;
    this.connection = options.connection;
    this.historicalDataEnabled = options.historicalDataEnabled !== undefined ?
      options.historicalDataEnabled : true;
    this.entityFactory = options.entityFactory;
    this.entityTarget = options.entityTarget;
  }

  public async storeInstallation<AuthVersion extends 'v1' | 'v2'>(
    i: Installation<AuthVersion, boolean>,
    logger?: Logger,
  ): Promise<void> {
    const enterpriseId = i.enterprise?.id;
    const teamId = i.team?.id;
    const userId = i.user.id;
    const isEnterpriseInstall = i.isEnterpriseInstall || false;
    const commonLogPart = `(enterprise_id: ${enterpriseId}, team_id: ${teamId}, user_id: ${userId})`;
    logger?.debug(`#storeInstallation starts ${commonLogPart}`);

    let row: InstallationEntity;
    if (this.historicalDataEnabled) {
      // In this mode, we always insert new row
      row = this.entityFactory();
      row.clientId = this.clientId;
    } else {
      const existingRow = await this.findRow({
        teamId,
        enterpriseId,
        userId,
        isEnterpriseInstall,
      });
      if (existingRow !== undefined) {
        row = existingRow;
      } else {
        row = this.entityFactory();
        row.clientId = this.clientId;
      }
    }
    this.setupRow(row, i);
    await this.connection.manager.save<InstallationEntity>(row);

    logger?.debug(`#storeInstallation successfully completed ${commonLogPart}`);
  }

  public async fetchInstallation(
    query: InstallationQuery<boolean>,
    logger?: Logger,
  ): Promise<Installation<'v1' | 'v2', boolean>> {
    const { enterpriseId, teamId, userId } = query;
    const commonLogPart = `(enterprise_id: ${enterpriseId}, team_id: ${teamId}, user_id: ${userId})`;
    logger?.debug(`#fetchInstallation starts ${commonLogPart}`);

    const row = await this.findRow(query);
    if (row) {
      return {
        team: row.teamId ?
          {
            id: row.teamId,
            name: row.teamName,
          } :
          undefined,
        enterprise: row.enterpriseId ?
          {
            id: row.enterpriseId,
            name: row.enterpriseName,
          } :
          undefined,
        enterpriseUrl: row.enterpriseUrl,
        user: {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          id: row.userId!,
          token: row.userToken,
          refreshToken: row.userRefreshToken,
          expiresAt: row.userTokenExpiresAt?.getTime(),
          scopes: row.userScopes?.split(','),
        },
        bot:
          row.botId && row.botUserId && row.botToken ?
            {
              id: row.botId,
              userId: row.botUserId,
              token: row.botToken,
              refreshToken: row.botRefreshToken,
              expiresAt: row.botTokenExpiresAt?.getTime(),
              scopes: row.botScopes?.split(',') || [],
            } :
            undefined,
        incomingWebhook: row.incomingWebhookUrl ?
          {
            url: row.incomingWebhookUrl,
            channel: row.incomingWebhookChannel,
            channelId: row.incomingWebhookChannelId,
            configurationUrl: row.incomingWebhookConfigurationUrl,
          } :
          undefined,
        appId: row.appId,
        // TODO: `as 'bot'` is a workaround; user type is not yet supported in TS
        tokenType: row.tokenType === undefined ? 'bot' : row.tokenType as 'bot',
        isEnterpriseInstall: row.isEnterpriseInstall,
        authVersion: 'v2', // This module does not support v1 installations
      };
    }
    logger?.debug(
      `#fetchInstallation didn't return any installation data ${commonLogPart}`,
    );
    throw new Error(`No installation data found ${commonLogPart}`);
  }

  public async deleteInstallation(
    query: InstallationQuery<boolean>,
    logger?: Logger,
  ): Promise<void> {
    const { enterpriseId, teamId, userId, isEnterpriseInstall } = query;
    const commonLogPart = `(enterprise_id: ${enterpriseId}, team_id: ${teamId}, user_id: ${userId})`;
    logger?.debug(`#deleteInstallation starts ${commonLogPart}`);

    await this.connection.manager
      .getRepository(this.entityTarget)
      .createQueryBuilder()
      .delete()
      .where([
        (this.clientId ? 'clientId = :clientId' : 'clientId is null'),
        (enterpriseId ? 'enterpriseId = :enterpriseId' : undefined),
        (isEnterpriseInstall ? 'teamId is null' : undefined),
        (!isEnterpriseInstall && teamId ? 'teamId = :teamId' : undefined),
        (userId ? 'userId = :userId' : undefined),
      ].filter((a) => a !== undefined).join(' AND '))
      .setParameters({ enterpriseId, teamId, userId, clientId: this.clientId })
      .execute();

    logger?.debug(
      `#deleteInstallation completed ${commonLogPart}`,
    );
  }

  // ------------------------------------------
  // private methods
  // ------------------------------------------

  private setupRow(entity: InstallationEntity, i: Installation) {
    const bothClientIdAbsent = (entity.clientId === null || entity.clientId === undefined) &&
      (this.clientId === undefined || this.clientId === null);
    if (!bothClientIdAbsent && entity.clientId !== this.clientId) {
      throw new Error(
        `Unexpected installation update (client_id: ${entity.clientId}) by a differnt app (client_id: ${this.clientId}) detected`,
      );
    }
    entity.clientId = this.clientId;
    entity.appId = i.appId;
    entity.enterpriseId = i.enterprise?.id;
    entity.enterpriseName = i.enterprise?.name;
    entity.enterpriseUrl = i.enterpriseUrl;
    entity.teamId = i.team?.id;
    entity.teamName = i.team?.name;
    entity.botToken = i.bot?.token;
    entity.botId = i.bot?.id;
    entity.botUserId = i.bot?.userId;
    entity.botScopes = i.bot?.scopes?.join(',');
    if (entity.botRefreshToken !== i.bot?.refreshToken) {
      entity.botRefreshToken = i.bot?.refreshToken;
      entity.botTokenExpiresAt = i.bot?.expiresAt ?
        new Date(i.bot.expiresAt) :
        undefined;
    }
    entity.userId = i.user.id;
    entity.userToken = i.user.token;
    entity.userScopes = i.user.scopes?.join(',');
    if (entity.userRefreshToken !== i.user.refreshToken) {
      entity.userRefreshToken = i.user.refreshToken;
      entity.userTokenExpiresAt = i.user?.expiresAt ?
        new Date(i.user.expiresAt) :
        undefined;
    }
    entity.incomingWebhookUrl = i.incomingWebhook?.url;
    entity.incomingWebhookChannel = i.incomingWebhook?.channel;
    entity.incomingWebhookChannelId = i.incomingWebhook?.channelId;
    entity.incomingWebhookConfigurationUrl = i.incomingWebhook?.configurationUrl;
    entity.isEnterpriseInstall = i.isEnterpriseInstall;
    // TODO: need to fix on the @slack/oauth side
    entity.tokenType = i.tokenType === undefined ? 'bot' : i.tokenType as 'bot';
    if (entity.installedAt === undefined) {
      entity.installedAt = new Date();
    }
  }

  private async findRow(query: InstallationQuery<boolean>): Promise<InstallationEntity | undefined> {
    const { enterpriseId, teamId, isEnterpriseInstall, userId } = query;
    const alias = 'i';
    const selectQuery = this.connection.manager
      .getRepository(this.entityTarget)
      .createQueryBuilder(alias)
      // Note that we don't need to worry about NamingStrategy compatibility here
      // TypeORM's internal where clause parser converts the property names such as clientId
      // into the corresponding column names. If you go with snake_case NamingStrategy,
      // the following where clause will use the naming conventions in SQL statements.
      .where([
        (this.clientId ? `${alias}.clientId = :clientId` : `${alias}.clientId is null`),
        (enterpriseId ? `${alias}.enterpriseId = :enterpriseId` : undefined),
        (isEnterpriseInstall ? `${alias}.teamId is null` : undefined),
        (!isEnterpriseInstall && teamId ? `${alias}.teamId = :teamId` : undefined),
        (userId ? `${alias}.userId = :userId` : undefined),
      ].filter((a) => a !== undefined).join(' AND '))
      .setParameters({ enterpriseId, teamId, userId, clientId: this.clientId });

    if (this.historicalDataEnabled) {
      return selectQuery.orderBy(`${alias}.installedAt`, 'DESC')
        .limit(1)
        .getOne();
    }
    return selectQuery.getOne();
  }
}
